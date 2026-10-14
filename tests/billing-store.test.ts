// The Supabase BillingStore over the in-memory fake (tests/support/fake-supabase.ts), for both providers. The SQL it relies on (composite keys, guarded
// updates, Row Level Security) was applied to a real Postgres engine when this template was built: BILLING.md says how to repeat that.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STALE_RECEIVED_MS, supabaseBillingStore } from "@/lib/billing/store";
import { UnknownUserError, type AdjustmentRow, type SubscriptionRow, type TransactionRow, type WebhookEventRecord } from "@/lib/billing/types";
import { billingDb } from "./support/fake-supabase";
import { CUSTOMER_ID, USER_ID } from "./support/billing-fixtures";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const setup = () => {
  const db = billingDb();
  return { db, store: supabaseBillingStore(db as unknown as SupabaseClient, () => NOW) };
};
const delivery = (id = "evt_1", over: Partial<WebhookEventRecord> = {}): WebhookEventRecord => ({
  provider: "paddle",
  event_id: id,
  event_type: "subscription.created",
  occurred_at: "2026-10-14T00:00:00Z",
  payload: { event_id: id },
  ...over,
});

const subscription = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id: "sub_1",
  provider: "paddle",
  user_id: USER_ID,
  customer_id: CUSTOMER_ID,
  status: "active",
  plan_key: "pro",
  price_id: "pri_pro_month",
  billing_interval: "month",
  quantity: 1,
  currency: "USD",
  unit_amount: 900,
  current_period_start: null,
  current_period_end: null,
  cancel_at_period_end: false,
  scheduled_change: null,
  canceled_at: null,
  event_occurred_at: "2026-10-14T00:00:00Z",
  ...over,
});

const transaction = (over: Partial<TransactionRow> = {}): TransactionRow => ({
  id: "txn_1",
  provider: "paddle",
  user_id: USER_ID,
  customer_id: CUSTOMER_ID,
  subscription_id: "sub_1",
  status: "completed",
  origin: "api",
  price_id: "pri_pro_month",
  item_key: "pro",
  currency: "USD",
  subtotal: 900,
  tax: 90,
  total: 990,
  invoice_number: null,
  billed_at: null,
  ...over,
});

const adjustment = (over: Partial<AdjustmentRow> = {}): AdjustmentRow => ({
  id: "adj_1",
  provider: "paddle",
  transaction_id: "txn_1",
  user_id: USER_ID,
  action: "refund",
  status: "approved",
  currency: "USD",
  total: 400,
  event_occurred_at: "2026-10-14T00:00:00Z",
  ...over,
});

describe("claimEvent", () => {
  it("claims a new event, and refuses a processed or ignored one as a duplicate", async () => {
    const { db, store } = setup();
    assert.equal(await store.claimEvent(delivery()), true);
    assert.equal(db.tables.billing_webhook_events[0].provider, "paddle");
    await store.finishEvent("paddle", "evt_1", "processed", "ok");
    assert.equal(await store.claimEvent(delivery()), false);
    await store.finishEvent("paddle", "evt_1", "ignored", "unknown_customer");
    assert.equal(await store.claimEvent(delivery()), false);
    assert.equal(db.tables.billing_webhook_events.length, 1);
  });

  it("takes a failed event over so that the redelivery is processed, exactly once", async () => {
    const { db, store } = setup();
    await store.claimEvent(delivery());
    await store.failEvent("paddle", "evt_1", "database is down");
    assert.equal(db.tables.billing_webhook_events[0].status, "failed");
    assert.equal(await store.claimEvent(delivery()), true);
    assert.equal(await store.claimEvent(delivery()), false, "a second delivery racing for it does not also win");
    assert.equal(db.tables.billing_webhook_events[0].status, "received");
  });

  it("leaves a fresh `received` event to the attempt that is running it, and takes over one that went stale", async () => {
    const { db, store } = setup();
    await store.claimEvent(delivery());
    db.tables.billing_webhook_events[0].received_at = new Date(NOW - 1000).toISOString();
    assert.equal(await store.claimEvent(delivery()), false);
    db.tables.billing_webhook_events[0].received_at = new Date(NOW - STALE_RECEIVED_MS - 1000).toISOString();
    assert.equal(await store.claimEvent(delivery()), true);
  });

  it("truncates a long failure message and keeps the payload", async () => {
    const { db, store } = setup();
    await store.claimEvent(delivery());
    await store.failEvent("paddle", "evt_1", "x".repeat(2000));
    assert.equal(String(db.tables.billing_webhook_events[0].note).length, 500);
    assert.deepEqual(db.tables.billing_webhook_events[0].payload, { event_id: "evt_1" });
  });

  it("keeps the two providers' delivery ids apart: the same id from Paddle and from Polar are two deliveries", async () => {
    const { db, store } = setup();
    assert.equal(await store.claimEvent(delivery("same")), true);
    assert.equal(await store.claimEvent(delivery("same", { provider: "polar" })), true);
    assert.equal(await store.claimEvent(delivery("same", { provider: "polar" })), false);
    await store.failEvent("polar", "same", "boom");
    assert.deepEqual(db.tables.billing_webhook_events.map((row) => [row.provider, row.status]).sort(), [["paddle", "received"], ["polar", "failed"]]);
  });
});

describe("upsertSubscription", () => {
  it("inserts a new subscription, and an event that is not older replaces it", async () => {
    const { db, store } = setup();
    await store.upsertSubscription(subscription());
    await store.upsertSubscription(subscription({ status: "past_due", event_occurred_at: "2026-10-15T00:00:00Z" }));
    assert.equal(db.tables.billing_subscriptions.length, 1);
    assert.equal(db.tables.billing_subscriptions[0].status, "past_due");
    await store.upsertSubscription(subscription({ status: "paused", event_occurred_at: "2026-10-15T00:00:00Z" }));
    assert.equal(db.tables.billing_subscriptions[0].status, "paused", "the same timestamp is not older");
  });

  it("never lets an older event overwrite a newer one", async () => {
    const { db, store } = setup();
    await store.upsertSubscription(subscription({ status: "canceled", event_occurred_at: "2026-11-14T00:00:00Z" }));
    await store.upsertSubscription(subscription({ status: "active", event_occurred_at: "2026-10-20T00:00:00Z" }));
    assert.equal(db.tables.billing_subscriptions[0].status, "canceled");
  });

  it("compares instants, not strings (providers write timestamps with and without milliseconds)", async () => {
    const { db, store } = setup();
    // As strings "…:10Z" sorts AFTER "…:10.500Z", but 10.500 is the later instant.
    await store.upsertSubscription(subscription({ status: "active", event_occurred_at: "2026-10-14T00:00:10Z" }));
    await store.upsertSubscription(subscription({ status: "canceled", event_occurred_at: "2026-10-14T00:00:10.500Z" }));
    assert.equal(db.tables.billing_subscriptions[0].status, "canceled");
    await store.upsertSubscription(subscription({ status: "active", event_occurred_at: "2026-10-14T00:00:10Z" }));
    assert.equal(db.tables.billing_subscriptions[0].status, "canceled", "and the earlier instant does not come back");
  });

  it("keeps a Paddle and a Polar subscription with the same id apart", async () => {
    const { db, store } = setup();
    await store.upsertSubscription(subscription({ id: "x", provider: "paddle", status: "active" }));
    await store.upsertSubscription(subscription({ id: "x", provider: "polar", status: "canceled" }));
    assert.deepEqual(db.tables.billing_subscriptions.map((row) => [row.provider, row.status]).sort(), [["paddle", "active"], ["polar", "canceled"]]);
  });
});

describe("transactions and refunds", () => {
  it("does not reset what the refunds added up when the payment is delivered again", async () => {
    const { db, store } = setup();
    await store.upsertTransaction(transaction());
    await store.upsertAdjustment(adjustment());
    await store.upsertAdjustment(adjustment({ id: "adj_2", action: "credit", total: 50 }));
    await store.upsertAdjustment(adjustment({ id: "adj_3", status: "pending_approval", total: 90 }));
    await store.recomputeRefunded("paddle", "txn_1");
    assert.equal(db.tables.billing_transactions[0].refunded, 400);
    await store.upsertTransaction(transaction({ invoice_number: "1001" }));
    assert.equal(db.tables.billing_transactions[0].refunded, 400);
    assert.equal(db.tables.billing_transactions[0].invoice_number, "1001");
  });

  it("counts chargebacks and takes back a reversed one", async () => {
    const { db, store } = setup();
    await store.upsertTransaction(transaction());
    await store.upsertAdjustment(adjustment({ id: "adj_cb", action: "chargeback", total: 200 }));
    await store.recomputeRefunded("paddle", "txn_1");
    assert.equal(db.tables.billing_transactions[0].refunded, 200);
    await store.upsertAdjustment(adjustment({ id: "adj_cb", action: "chargeback", status: "reversed", total: 200, event_occurred_at: "2026-10-14T00:05:00Z" }));
    await store.recomputeRefunded("paddle", "txn_1");
    assert.equal(db.tables.billing_transactions[0].refunded, 0);
  });

  it("never lets a late, older delivery undo an approved refund", async () => {
    const { db, store } = setup();
    await store.upsertTransaction(transaction());
    await store.upsertAdjustment(adjustment({ status: "approved", event_occurred_at: "2026-10-14T00:10:00Z" }));
    await store.upsertAdjustment(adjustment({ status: "pending_approval", event_occurred_at: "2026-10-14T00:05:00Z" }));
    await store.recomputeRefunded("paddle", "txn_1");
    assert.equal(db.tables.billing_adjustments[0].status, "approved");
    assert.equal(db.tables.billing_transactions[0].refunded, 400);
  });

  it("finds a transaction it recorded, and not one it did not (nor one of the other provider)", async () => {
    const { store } = setup();
    await store.upsertTransaction(transaction());
    assert.deepEqual(await store.getTransaction("paddle", "txn_1"), { id: "txn_1", user_id: USER_ID });
    assert.equal(await store.getTransaction("paddle", "txn_other"), null);
    assert.equal(await store.getTransaction("polar", "txn_1"), null);
  });

  it("adds up a Polar order's refund without touching a Paddle payment of the same id", async () => {
    const { db, store } = setup();
    await store.upsertTransaction(transaction({ id: "o1", provider: "paddle" }));
    await store.upsertTransaction(transaction({ id: "o1", provider: "polar", customer_id: "polar-customer" }));
    await store.upsertAdjustment(adjustment({ id: "refund_o1", provider: "polar", transaction_id: "o1", total: 330 }));
    await store.recomputeRefunded("polar", "o1");
    const refunded = Object.fromEntries(db.tables.billing_transactions.map((row) => [row.provider as string, Number(row.refunded ?? 0)]));
    assert.deepEqual(refunded, { paddle: 0, polar: 330 });
  });
});

describe("userIdForCustomer", () => {
  it("answers through the Paddle customer link only, and never for Polar (its payload carries the user id)", async () => {
    const { db, store } = setup();
    db.tables.billing_customers.push({ user_id: USER_ID, paddle_customer_id: CUSTOMER_ID });
    assert.equal(await store.userIdForCustomer("paddle", CUSTOMER_ID), USER_ID);
    assert.equal(await store.userIdForCustomer("paddle", "ctm_01stranger"), null);
    assert.equal(await store.userIdForCustomer("polar", CUSTOMER_ID), null);
  });
});

describe("a user who does not exist (any more)", () => {
  it("turns the database's foreign key refusal into UnknownUserError (a delivery answers it with ignored), for every write of a user's rows", async () => {
    const { db, store } = setup();
    db.users = new Set(["someone-else"]);
    await assert.rejects(store.upsertSubscription(subscription()), UnknownUserError);
    await assert.rejects(store.upsertTransaction(transaction()), UnknownUserError);
    await assert.rejects(store.upsertAdjustment(adjustment()), UnknownUserError);
    assert.equal(db.tables.billing_subscriptions.length + db.tables.billing_transactions.length + db.tables.billing_adjustments.length, 0);
  });

  it("does not hide any other database error", async () => {
    const db = billingDb();
    const broken = { from: () => ({ upsert: async () => ({ data: null, error: { code: "08006", message: "connection failure" } }) }) } as unknown as SupabaseClient;
    await assert.rejects(supabaseBillingStore(broken).upsertSubscription(subscription()), /connection failure/);
    assert.equal(db.tables.billing_subscriptions.length, 0);
  });
});
