import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STALE_RECEIVED_MS, supabaseBillingStore } from "@/lib/paddle/store";
import type { SubscriptionRow, TransactionRow } from "@/lib/paddle/types";
import { billingDb } from "./support/fake-supabase";
import { CUSTOMER_ID, USER_ID } from "./support/paddle-fixtures";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const setup = () => {
  const db = billingDb();
  return { db, store: supabaseBillingStore(db as unknown as SupabaseClient, () => NOW) };
};
const delivery = (id = "evt_1") => ({ event_id: id, event_type: "subscription.created", occurred_at: "2026-10-14T00:00:00Z", payload: { event_id: id } });

const subscription = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id: "sub_1",
  user_id: USER_ID,
  paddle_customer_id: CUSTOMER_ID,
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
  user_id: USER_ID,
  paddle_customer_id: CUSTOMER_ID,
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

describe("claimEvent", () => {
  it("claims a new event, and refuses a processed or ignored one as a duplicate", async () => {
    const { db, store } = setup();
    assert.equal(await store.claimEvent(delivery()), true);
    await store.finishEvent("evt_1", "processed", "ok");
    assert.equal(await store.claimEvent(delivery()), false);
    await store.finishEvent("evt_1", "ignored", "unknown_customer");
    assert.equal(await store.claimEvent(delivery()), false);
    assert.equal(db.tables.billing_webhook_events.length, 1);
  });

  it("takes a failed event over so that the redelivery is processed, exactly once", async () => {
    const { db, store } = setup();
    await store.claimEvent(delivery());
    await store.failEvent("evt_1", "database is down");
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
    await store.failEvent("evt_1", "x".repeat(2000));
    assert.equal(String(db.tables.billing_webhook_events[0].note).length, 500);
    assert.deepEqual(db.tables.billing_webhook_events[0].payload, { event_id: "evt_1" });
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
});

describe("transactions and refunds", () => {
  it("does not reset what the refunds added up when the payment is delivered again", async () => {
    const { db, store } = setup();
    await store.upsertTransaction(transaction());
    await store.upsertAdjustment({ id: "adj_1", transaction_id: "txn_1", user_id: USER_ID, action: "refund", status: "approved", currency: "USD", total: 400 });
    await store.upsertAdjustment({ id: "adj_2", transaction_id: "txn_1", user_id: USER_ID, action: "credit", status: "approved", currency: "USD", total: 50 });
    await store.upsertAdjustment({ id: "adj_3", transaction_id: "txn_1", user_id: USER_ID, action: "refund", status: "pending_approval", currency: "USD", total: 90 });
    await store.recomputeRefunded("txn_1");
    assert.equal(db.tables.billing_transactions[0].refunded, 400);
    await store.upsertTransaction(transaction({ status: "completed", invoice_number: "1001" }));
    assert.equal(db.tables.billing_transactions[0].refunded, 400);
    assert.equal(db.tables.billing_transactions[0].invoice_number, "1001");
  });

  it("finds a transaction it recorded, and not one it did not", async () => {
    const { store } = setup();
    await store.upsertTransaction(transaction());
    assert.deepEqual(await store.getTransaction("txn_1"), { id: "txn_1", user_id: USER_ID });
    assert.equal(await store.getTransaction("txn_other"), null);
  });
});

describe("userIdForCustomer", () => {
  it("answers through the customer link only", async () => {
    const { db, store } = setup();
    db.tables.billing_customers.push({ user_id: USER_ID, paddle_customer_id: CUSTOMER_ID });
    assert.equal(await store.userIdForCustomer(CUSTOMER_ID), USER_ID);
    assert.equal(await store.userIdForCustomer("ctm_01stranger"), null);
  });
});
