import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPaddleEvent, minor, parsePaddleEvent, processPaddleDelivery } from "@/lib/paddle/webhook";
import { adjustmentData, context, CUSTOMER_ID, event, MemoryStore, subscriptionData, transactionData, USER_ID } from "./support/paddle-fixtures";

const ctx = context();

describe("subscription events", () => {
  it("writes the subscription of a known customer, with the plan, the period and the price", async () => {
    const store = new MemoryStore();
    const result = await applyPaddleEvent(store, event("subscription.created", subscriptionData({ status: "trialing" })), ctx);
    assert.equal(result.status, "processed");
    assert.deepEqual(store.subscriptions.get("sub_01test"), {
      id: "sub_01test",
      user_id: USER_ID,
      paddle_customer_id: CUSTOMER_ID,
      status: "trialing",
      plan_key: "pro",
      price_id: "pri_pro_month",
      billing_interval: "month",
      quantity: 1,
      currency: "USD",
      unit_amount: 900,
      current_period_start: "2026-10-14T00:00:00Z",
      current_period_end: "2026-11-14T00:00:00Z",
      cancel_at_period_end: false,
      scheduled_change: null,
      canceled_at: null,
      event_occurred_at: "2026-10-14T00:00:10Z",
    });
  });

  it("reads a scheduled cancellation as cancel_at_period_end, and a cancellation as canceled", async () => {
    const store = new MemoryStore();
    const scheduled = { action: "cancel", effective_at: "2026-11-14T00:00:00Z", resume_at: null };
    await applyPaddleEvent(store, event("subscription.updated", subscriptionData({ scheduled_change: scheduled }), "2026-10-20T00:00:00Z"), ctx);
    assert.equal(store.subscriptions.get("sub_01test")?.cancel_at_period_end, true);
    await applyPaddleEvent(store, event("subscription.canceled", subscriptionData({ status: "canceled", canceled_at: "2026-11-14T00:00:00Z" }), "2026-11-14T00:00:01Z"), ctx);
    const row = store.subscriptions.get("sub_01test");
    assert.equal(row?.status, "canceled");
    assert.equal(row?.cancel_at_period_end, false);
    assert.equal(row?.canceled_at, "2026-11-14T00:00:00Z");
  });

  it("never lets an older event overwrite a newer one (events arrive out of order)", async () => {
    const store = new MemoryStore();
    await applyPaddleEvent(store, event("subscription.canceled", subscriptionData({ status: "canceled" }), "2026-11-14T00:00:00Z"), ctx);
    await applyPaddleEvent(store, event("subscription.updated", subscriptionData({ status: "active" }), "2026-10-20T00:00:00Z"), ctx);
    assert.equal(store.subscriptions.get("sub_01test")?.status, "canceled");
  });

  it("understands a yearly price and the plan it belongs to", async () => {
    const store = new MemoryStore();
    const yearly = { quantity: 1, recurring: true, price: { id: "pri_team_year", unit_price: { amount: "29000", currency_code: "USD" }, billing_cycle: { interval: "year", frequency: 1 } } };
    await applyPaddleEvent(store, event("subscription.activated", subscriptionData({ items: [yearly], billing_cycle: { interval: "year", frequency: 1 } })), ctx);
    const row = store.subscriptions.get("sub_01test");
    assert.equal(row?.plan_key, "team");
    assert.equal(row?.billing_interval, "year");
    assert.equal(row?.unit_amount, 29000);
  });

  it("ignores a customer the server never linked to a user, whatever the custom data claims", async () => {
    const store = new MemoryStore();
    const forged = subscriptionData({ customer_id: "ctm_01stranger", custom_data: { app: "test-app", user_id: USER_ID } });
    const result = await applyPaddleEvent(store, event("subscription.created", forged), ctx);
    assert.deepEqual(result, { status: "ignored", note: "unknown_customer" });
    assert.equal(store.subscriptions.size, 0);
  });

  it("ignores another app's subscription (same Paddle account, other tag) and a price that is not ours", async () => {
    const store = new MemoryStore();
    const foreign = await applyPaddleEvent(store, event("subscription.created", subscriptionData({ custom_data: { app: "other-app", user_id: USER_ID } })), ctx);
    assert.deepEqual(foreign, { status: "ignored", note: "other_app" });
    const notOurs = { quantity: 1, price: { id: "pri_someone_elses", unit_price: { amount: "100", currency_code: "USD" } } };
    const stranger = await applyPaddleEvent(store, event("subscription.created", subscriptionData({ items: [notOurs] })), ctx);
    assert.deepEqual(stranger, { status: "ignored", note: "not_our_price" });
    assert.equal(store.subscriptions.size, 0);
  });

  it("ignores a subscription event without a tag only when the price is not ours (an untagged event of our price is still ours)", async () => {
    const store = new MemoryStore();
    const untagged = await applyPaddleEvent(store, event("subscription.updated", subscriptionData({ custom_data: null })), ctx);
    assert.equal(untagged.status, "processed");
  });

  it("ignores a status it does not know instead of storing something the table would refuse", async () => {
    const store = new MemoryStore();
    const result = await applyPaddleEvent(store, event("subscription.updated", subscriptionData({ status: "teleported" })), ctx);
    assert.deepEqual(result, { status: "ignored", note: "unknown_status_teleported" });
  });
});

describe("transaction.completed", () => {
  it("records a payment with what the customer paid (the grand total) and the invoice", async () => {
    const store = new MemoryStore();
    const result = await applyPaddleEvent(store, event("transaction.completed", transactionData()), ctx);
    assert.equal(result.status, "processed");
    assert.deepEqual(store.transactions.get("txn_01test"), {
      id: "txn_01test",
      user_id: USER_ID,
      paddle_customer_id: CUSTOMER_ID,
      subscription_id: "sub_01test",
      status: "completed",
      origin: "api",
      price_id: "pri_pro_month",
      item_key: "pro",
      currency: "USD",
      subtotal: 900,
      tax: 90,
      total: 990,
      refunded: 0,
      invoice_number: "1001-10001",
      billed_at: "2026-10-14T00:00:05Z",
    });
  });

  it("records a one-time product under its own key", async () => {
    const store = new MemoryStore();
    const items = [{ quantity: 1, price_id: "pri_credits_100", price: { id: "pri_credits_100" } }];
    await applyPaddleEvent(store, event("transaction.completed", transactionData({ id: "txn_pack", subscription_id: null, items })), ctx);
    assert.equal(store.transactions.get("txn_pack")?.item_key, "credits_100");
    assert.equal(store.transactions.get("txn_pack")?.subscription_id, null);
  });

  it("ignores a payment of an unknown customer, of another app, or for a price that is not ours", async () => {
    const store = new MemoryStore();
    assert.equal((await applyPaddleEvent(store, event("transaction.completed", transactionData({ customer_id: "ctm_01stranger" })), ctx)).note, "unknown_customer");
    assert.equal((await applyPaddleEvent(store, event("transaction.completed", transactionData({ customer_id: null })), ctx)).note, "no_customer");
    assert.equal((await applyPaddleEvent(store, event("transaction.completed", transactionData({ custom_data: { app: "other-app" } })), ctx)).note, "other_app");
    assert.equal((await applyPaddleEvent(store, event("transaction.completed", transactionData({ items: [{ price_id: "pri_x", price: { id: "pri_x" } }] })), ctx)).note, "not_our_price");
    assert.equal(store.transactions.size, 0);
  });

  it("keeps what a refund added up when the same payment is delivered again", async () => {
    const store = new MemoryStore();
    await applyPaddleEvent(store, event("transaction.completed", transactionData()), ctx);
    await applyPaddleEvent(store, event("adjustment.updated", adjustmentData()), ctx);
    await applyPaddleEvent(store, event("transaction.completed", transactionData()), ctx);
    assert.equal(store.transactions.get("txn_01test")?.refunded, 990);
  });
});

describe("adjustments (refunds)", () => {
  it("adds up approved refunds and chargebacks, and nothing else", async () => {
    const store = new MemoryStore();
    await applyPaddleEvent(store, event("transaction.completed", transactionData()), ctx);
    await applyPaddleEvent(store, event("adjustment.created", adjustmentData({ id: "adj_pending", status: "pending_approval", totals: { total: "300" } })), ctx);
    assert.equal(store.transactions.get("txn_01test")?.refunded, 0, "a refund that is not approved yet is not a refund");
    await applyPaddleEvent(store, event("adjustment.updated", adjustmentData({ id: "adj_pending", status: "approved", totals: { total: "300" } })), ctx);
    assert.equal(store.transactions.get("txn_01test")?.refunded, 300);
    await applyPaddleEvent(store, event("adjustment.created", adjustmentData({ id: "adj_cb", action: "chargeback", totals: { total: "200" } })), ctx);
    await applyPaddleEvent(store, event("adjustment.created", adjustmentData({ id: "adj_credit", action: "credit", totals: { total: "50" } })), ctx);
    await applyPaddleEvent(store, event("adjustment.created", adjustmentData({ id: "adj_rej", status: "rejected", totals: { total: "40" } })), ctx);
    assert.equal(store.transactions.get("txn_01test")?.refunded, 500);
    await applyPaddleEvent(store, event("adjustment.updated", adjustmentData({ id: "adj_cb", action: "chargeback", status: "reversed", totals: { total: "200" } })), ctx);
    assert.equal(store.transactions.get("txn_01test")?.refunded, 300, "a reversed chargeback is taken back");
  });

  it("ignores an adjustment of a payment we never recorded (it belongs to another app)", async () => {
    const store = new MemoryStore();
    const result = await applyPaddleEvent(store, event("adjustment.created", adjustmentData({ transaction_id: "txn_other" })), ctx);
    assert.deepEqual(result, { status: "ignored", note: "unknown_transaction" });
    assert.equal(store.adjustments.size, 0);
  });
});

describe("a delivery", () => {
  it("is processed once: a second delivery of the same event id is a duplicate that changes nothing", async () => {
    const store = new MemoryStore();
    const delivery = event("subscription.created", subscriptionData(), "2026-10-14T00:00:10Z", "evt_same");
    assert.equal((await processPaddleDelivery(store, delivery, ctx)).status, "processed");
    store.subscriptions.clear();
    assert.equal((await processPaddleDelivery(store, delivery, ctx)).status, "duplicate");
    assert.equal(store.subscriptions.size, 0, "the duplicate was not applied again");
    assert.equal(store.events.get("evt_same")?.status, "processed");
  });

  it("records an ignored event as ignored, with the reason", async () => {
    const store = new MemoryStore();
    await processPaddleDelivery(store, event("subscription.created", subscriptionData({ customer_id: "ctm_01stranger" }), "2026-10-14T00:00:10Z", "evt_stranger"), ctx);
    assert.deepEqual(store.events.get("evt_stranger"), { status: "ignored", note: "unknown_customer" });
  });

  it("answers an event type it does not handle with ignored, not an error (Paddle would retry an error)", async () => {
    const store = new MemoryStore();
    const result = await processPaddleDelivery(store, event("customer.updated", { id: "ctm_1" }), ctx);
    assert.deepEqual(result, { status: "ignored", note: "unhandled_event_type" });
  });

  it("fails loudly when the database fails, records the failure, and processes the redelivery", async () => {
    const store = new MemoryStore();
    const delivery = event("subscription.created", subscriptionData(), "2026-10-14T00:00:10Z", "evt_retry");
    store.failNextWrite = true;
    await assert.rejects(processPaddleDelivery(store, delivery, ctx), /database is down/);
    assert.equal(store.events.get("evt_retry")?.status, "failed");
    assert.equal(store.subscriptions.size, 0);
    assert.equal((await processPaddleDelivery(store, delivery, ctx)).status, "processed");
    assert.equal(store.subscriptions.size, 1);
  });
});

describe("parsePaddleEvent and minor", () => {
  it("accepts a well-formed event and refuses anything else", () => {
    const body = JSON.stringify({ event_id: "evt_1", event_type: "subscription.created", occurred_at: "2026-10-14T00:00:10Z", data: { id: "sub_1" } });
    assert.equal(parsePaddleEvent(body)?.event_id, "evt_1");
    for (const bad of ["", "not json", "null", "[]", "{}", JSON.stringify({ event_id: "e", event_type: "t", occurred_at: "yesterday", data: {} }), JSON.stringify({ event_id: 1, event_type: "t", occurred_at: "2026-10-14T00:00:10Z", data: {} }), JSON.stringify({ event_id: "e", event_type: "t", occurred_at: "2026-10-14T00:00:10Z" })]) {
      assert.equal(parsePaddleEvent(bad), null, bad);
    }
  });

  it("reads Paddle's money strings, and a bad amount as 0", () => {
    assert.equal(minor("990"), 990);
    assert.equal(minor(990), 990);
    for (const bad of [undefined, null, "", "12.5", "abc", {}, "9".repeat(30)]) assert.equal(minor(bad), 0, String(bad));
  });
});
