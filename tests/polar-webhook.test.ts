import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPolarEvent, parsePolarEvent, polarOrderRowsFrom, polarSubscriptionRowFrom, polarUid, POLAR_EVENTS, processPolarDelivery } from "@/lib/billing/polar/webhook";
import { MemoryStore, OTHER_USER_ID, polarCustomer, polarContext, polarEvent, polarOrderData, polarSubscriptionData, POLAR_CUSTOMER_ID, USER_ID } from "./support/billing-fixtures";

const ctx = polarContext();
const SUB = "polar_6a1f0c52-0000-4000-8000-0000000000a1";
const ORDER = "polar_9d2e7a10-0000-4000-8000-0000000000b1";

describe("subscription events", () => {
  it("writes the subscription of the user the server set as the customer, with the plan, the period and the product", async () => {
    const store = new MemoryStore();
    const result = await applyPolarEvent(store, polarEvent("subscription.active", polarSubscriptionData()), ctx);
    assert.equal(result.status, "processed");
    assert.deepEqual(store.subscriptions.get(SUB), {
      id: "6a1f0c52-0000-4000-8000-0000000000a1",
      provider: "polar",
      user_id: USER_ID,
      customer_id: POLAR_CUSTOMER_ID,
      status: "active",
      plan_key: "pro",
      price_id: "prod_pro_month",
      billing_interval: "month",
      quantity: 1,
      currency: "USD",
      unit_amount: 900,
      current_period_start: "2026-10-14T00:00:00.000000Z",
      current_period_end: "2026-11-14T00:00:00.000000Z",
      cancel_at_period_end: false,
      scheduled_change: null,
      canceled_at: null,
      event_occurred_at: "2026-10-14T00:00:03.000000Z",
    });
  });

  it("reads a scheduled cancellation as cancel_at_period_end (the plan stays active until the period ends), and the end as canceled", async () => {
    const store = new MemoryStore();
    await applyPolarEvent(store, polarEvent("subscription.canceled", polarSubscriptionData({ cancel_at_period_end: true, canceled_at: "2026-10-20T00:00:00Z", ends_at: "2026-11-14T00:00:00Z", modified_at: "2026-10-20T00:00:00Z" })), ctx);
    assert.equal(store.subscriptions.get(SUB)?.status, "active");
    assert.equal(store.subscriptions.get(SUB)?.cancel_at_period_end, true);
    await applyPolarEvent(store, polarEvent("subscription.revoked", polarSubscriptionData({ status: "canceled", cancel_at_period_end: true, ended_at: "2026-11-14T00:00:00Z", modified_at: "2026-11-14T00:00:01Z" })), ctx);
    assert.equal(store.subscriptions.get(SUB)?.status, "canceled");
  });

  it("takes a cancellation back (subscription.uncanceled)", async () => {
    const store = new MemoryStore();
    await applyPolarEvent(store, polarEvent("subscription.canceled", polarSubscriptionData({ cancel_at_period_end: true, modified_at: "2026-10-20T00:00:00Z" })), ctx);
    await applyPolarEvent(store, polarEvent("subscription.uncanceled", polarSubscriptionData({ cancel_at_period_end: false, modified_at: "2026-10-21T00:00:00Z" })), ctx);
    assert.equal(store.subscriptions.get(SUB)?.cancel_at_period_end, false);
  });

  it("maps the statuses: trialing, past_due, and the three that end access", async () => {
    const expected: [string, string][] = [["trialing", "trialing"], ["past_due", "past_due"], ["canceled", "canceled"], ["unpaid", "canceled"], ["incomplete_expired", "canceled"]];
    for (const [polar, ours] of expected) {
      const row = polarSubscriptionRowFrom(polarSubscriptionData({ status: polar }) as never, ctx);
      assert.ok(!("ignored" in row), polar);
      assert.equal(row.status, ours, polar);
    }
  });

  it("ignores a subscription that has not been paid yet (incomplete) and a status it does not know", async () => {
    const store = new MemoryStore();
    assert.deepEqual(await applyPolarEvent(store, polarEvent("subscription.created", polarSubscriptionData({ status: "incomplete" })), ctx), { status: "ignored", note: "not_started" });
    assert.deepEqual(await applyPolarEvent(store, polarEvent("subscription.updated", polarSubscriptionData({ status: "teleported" })), ctx), { status: "ignored", note: "unknown_status_teleported" });
    assert.equal(store.subscriptions.size, 0);
  });

  it("never lets an older state overwrite a newer one (events arrive out of order)", async () => {
    const store = new MemoryStore();
    await applyPolarEvent(store, polarEvent("subscription.revoked", polarSubscriptionData({ status: "canceled", modified_at: "2026-11-14T00:00:00Z" })), ctx);
    await applyPolarEvent(store, polarEvent("subscription.updated", polarSubscriptionData({ status: "active", modified_at: "2026-10-20T00:00:00.123456Z" })), ctx);
    assert.equal(store.subscriptions.get(SUB)?.status, "canceled");
  });

  it("uses created_at for a subscription that was never modified", () => {
    const row = polarSubscriptionRowFrom(polarSubscriptionData({ modified_at: null }) as never, ctx);
    assert.ok(!("ignored" in row));
    assert.equal(row.event_occurred_at, "2026-10-14T00:00:00.000000Z");
  });

  it("understands a yearly product and the plan it belongs to", async () => {
    const store = new MemoryStore();
    await applyPolarEvent(store, polarEvent("subscription.active", polarSubscriptionData({ product_id: "prod_team_year", recurring_interval: "year", amount: 29000 })), ctx);
    const row = store.subscriptions.get(SUB);
    assert.equal(row?.plan_key, "team");
    assert.equal(row?.billing_interval, "year");
    assert.equal(row?.unit_amount, 29000);
  });

  it("credits only the external customer id the server set: not the metadata, not the e-mail", async () => {
    const store = new MemoryStore();
    const noExternal = polarSubscriptionData({ customer: polarCustomer(null), metadata: { user_id: USER_ID } });
    assert.deepEqual(await applyPolarEvent(store, polarEvent("subscription.active", noExternal), ctx), { status: "ignored", note: "no_customer" });
    assert.deepEqual(await applyPolarEvent(store, polarEvent("subscription.active", polarSubscriptionData({ customer: undefined })), ctx), { status: "ignored", note: "no_customer" });
    // a payload whose metadata names someone else is still the external customer's
    await applyPolarEvent(store, polarEvent("subscription.active", polarSubscriptionData({ metadata: { user_id: OTHER_USER_ID } })), ctx);
    assert.equal(store.subscriptions.get(SUB)?.user_id, USER_ID);
    assert.equal(polarUid({ external_id: "" }), null);
    assert.equal(polarUid(null), null);
  });

  it("ignores an external customer id that is not a user id of this app (another app sharing the Polar organization uses other ids)", async () => {
    const store = new MemoryStore();
    for (const external of ["sbx-alice", "123", "not-a-uuid", "11111111-1111-4111-8111-11111111111", `${USER_ID}-x`]) {
      assert.deepEqual(await applyPolarEvent(store, polarEvent("subscription.active", polarSubscriptionData({ customer: polarCustomer(external) })), ctx), { status: "ignored", note: "no_customer" }, external);
    }
    assert.equal(polarUid({ external_id: USER_ID.toUpperCase() }), USER_ID.toUpperCase(), "a UUID is a UUID in either case");
    assert.equal(store.subscriptions.size, 0);
  });

  it("ignores a product that is not in .env (another app's product, or one that was never configured)", async () => {
    const store = new MemoryStore();
    assert.deepEqual(await applyPolarEvent(store, polarEvent("subscription.active", polarSubscriptionData({ product_id: "prod_someone_elses" })), ctx), { status: "ignored", note: "not_our_product" });
    assert.equal(store.subscriptions.size, 0);
  });
});

describe("order events", () => {
  it("records a payment with what the customer paid (tax included), the net amount and the invoice", async () => {
    const store = new MemoryStore();
    const result = await applyPolarEvent(store, polarEvent("order.paid", polarOrderData()), ctx);
    assert.equal(result.status, "processed");
    assert.deepEqual(store.transactions.get(ORDER), {
      id: "9d2e7a10-0000-4000-8000-0000000000b1",
      provider: "polar",
      user_id: USER_ID,
      customer_id: POLAR_CUSTOMER_ID,
      subscription_id: "6a1f0c52-0000-4000-8000-0000000000a1",
      status: "completed",
      origin: "subscription_create",
      price_id: "prod_pro_month",
      item_key: "pro",
      currency: "USD",
      subtotal: 900,
      tax: 90,
      total: 990,
      refunded: 0,
      invoice_number: "TEST-0001",
      billed_at: "2026-10-14T00:00:05.000000Z",
    });
    assert.equal(store.adjustments.size, 0, "nothing refunded: no adjustment");
  });

  it("records a one-time product under its own key, and a renewal like any other payment", async () => {
    const store = new MemoryStore();
    await applyPolarEvent(store, polarEvent("order.paid", polarOrderData({ id: "pack", product_id: "prod_credits_100", subscription_id: null, billing_reason: "purchase" })), ctx);
    assert.equal(store.transactions.get("polar_pack")?.item_key, "credits_100");
    assert.equal(store.transactions.get("polar_pack")?.subscription_id, null);
    await applyPolarEvent(store, polarEvent("order.paid", polarOrderData({ id: "renewal", billing_reason: "subscription_cycle" })), ctx);
    assert.equal(store.transactions.get("polar_renewal")?.origin, "subscription_cycle");
  });

  it("falls back to net + tax when Polar does not send the total", () => {
    const rows = polarOrderRowsFrom(polarOrderData({ total_amount: null }) as never, ctx);
    assert.ok(!("ignored" in rows));
    assert.equal(rows.transaction.total, 990);
  });

  it("ignores an order that was not paid (a draft or a pending one), another product, and a customer we did not set", async () => {
    const store = new MemoryStore();
    assert.deepEqual(await applyPolarEvent(store, polarEvent("order.updated", polarOrderData({ status: "pending", paid: false })), ctx), { status: "ignored", note: "not_paid" });
    assert.deepEqual(await applyPolarEvent(store, polarEvent("order.paid", polarOrderData({ product_id: "prod_x" })), ctx), { status: "ignored", note: "not_our_product" });
    assert.deepEqual(await applyPolarEvent(store, polarEvent("order.paid", polarOrderData({ customer: polarCustomer(null) })), ctx), { status: "ignored", note: "no_customer" });
    assert.equal(store.transactions.size, 0);
  });

  it("turns a partial refund into one approved adjustment, tax included, and adds it up", async () => {
    const store = new MemoryStore();
    await applyPolarEvent(store, polarEvent("order.paid", polarOrderData()), ctx);
    await applyPolarEvent(store, polarEvent("order.updated", polarOrderData({ status: "partially_refunded", refunded_amount: 300, refunded_tax_amount: 30, modified_at: "2026-10-15T00:00:00Z" })), ctx);
    assert.equal(store.transactions.get(ORDER)?.refunded, 330);
    assert.equal(store.transactions.get(ORDER)?.status, "completed", "a refunded order was still a payment");
    assert.deepEqual(
      [...store.adjustments.values()].map((a) => [a.id, a.action, a.status, a.total, a.currency]),
      [[`refund_9d2e7a10-0000-4000-8000-0000000000b1`, "refund", "approved", 330, "USD"]],
    );
  });

  it("follows a refund to the whole payment, and never goes back down when an older delivery arrives late", async () => {
    const store = new MemoryStore();
    await applyPolarEvent(store, polarEvent("order.paid", polarOrderData()), ctx);
    await applyPolarEvent(store, polarEvent("order.refunded", polarOrderData({ status: "refunded", refunded_amount: 900, refunded_tax_amount: 90, modified_at: "2026-10-16T00:00:00Z" })), ctx);
    assert.equal(store.transactions.get(ORDER)?.refunded, 990);
    await applyPolarEvent(store, polarEvent("order.updated", polarOrderData({ status: "partially_refunded", refunded_amount: 300, refunded_tax_amount: 30, modified_at: "2026-10-15T00:00:00Z" })), ctx);
    assert.equal(store.transactions.get(ORDER)?.refunded, 990);
  });

  it("keeps what a refund added up when the payment is delivered again", async () => {
    const store = new MemoryStore();
    await applyPolarEvent(store, polarEvent("order.refunded", polarOrderData({ status: "refunded", refunded_amount: 900, refunded_tax_amount: 90, modified_at: "2026-10-16T00:00:00Z" })), ctx);
    await applyPolarEvent(store, polarEvent("order.paid", polarOrderData()), ctx);
    assert.equal(store.transactions.get(ORDER)?.refunded, 990);
  });
});

describe("a delivery", () => {
  it("is processed once: a second delivery of the same message id is a duplicate that changes nothing", async () => {
    const store = new MemoryStore();
    const delivery = polarEvent("subscription.active", polarSubscriptionData(), "2026-10-14T00:00:10Z", "msg_same");
    assert.equal((await processPolarDelivery(store, delivery, ctx)).status, "processed");
    store.subscriptions.clear();
    assert.equal((await processPolarDelivery(store, delivery, ctx)).status, "duplicate");
    assert.equal(store.subscriptions.size, 0, "the duplicate was not applied again");
    assert.equal(store.events.get("polar_msg_same")?.status, "processed");
  });

  it("does not mix up the delivery ids of the two providers", async () => {
    const store = new MemoryStore();
    store.events.set("paddle_msg_clash", { status: "processed", note: "x" });
    const result = await processPolarDelivery(store, polarEvent("subscription.active", polarSubscriptionData(), "2026-10-14T00:00:10Z", "msg_clash"), ctx);
    assert.equal(result.status, "processed");
  });

  it("answers an event type it does not handle with ignored, not an error (Polar would retry an error)", async () => {
    const store = new MemoryStore();
    for (const type of ["customer.state_changed", "checkout.updated", "benefit_grant.created"]) {
      assert.deepEqual(await processPolarDelivery(store, polarEvent(type, { id: "x" }), ctx), { status: "ignored", note: "unhandled_event_type" }, type);
    }
  });

  it("fails loudly when the database fails, records the failure, and processes the redelivery", async () => {
    const store = new MemoryStore();
    const delivery = polarEvent("subscription.active", polarSubscriptionData(), "2026-10-14T00:00:10Z", "msg_retry");
    store.failNextWrite = true;
    await assert.rejects(processPolarDelivery(store, delivery, ctx), /database is down/);
    assert.equal(store.events.get("polar_msg_retry")?.status, "failed");
    assert.equal(store.subscriptions.size, 0);
    assert.equal((await processPolarDelivery(store, delivery, ctx)).status, "processed");
    assert.equal(store.subscriptions.size, 1);
  });
});

describe("parsePolarEvent", () => {
  const body = JSON.stringify({ type: "order.paid", timestamp: "2026-10-14T00:00:10Z", data: { id: "o" } });

  it("takes the delivery id from the webhook-id header and the rest from the body", () => {
    assert.deepEqual(parsePolarEvent(body, "msg_1"), { event_id: "msg_1", event_type: "order.paid", occurred_at: "2026-10-14T00:00:10Z", data: { id: "o" } });
  });

  it("refuses anything that is not an event, and an event without a delivery id", () => {
    assert.equal(parsePolarEvent(body, null), null);
    assert.equal(parsePolarEvent(body, ""), null);
    for (const bad of ["", "not json", "null", "[]", "{}", JSON.stringify({ type: 1, data: {} }), JSON.stringify({ type: "x" }), JSON.stringify({ type: "x", data: "y" })]) {
      assert.equal(parsePolarEvent(bad, "msg_1"), null, bad);
    }
  });

  it("uses the time of arrival when the timestamp is missing or not a date", () => {
    const fixed = () => "2026-01-01T00:00:00.000Z";
    assert.equal(parsePolarEvent(JSON.stringify({ type: "x", data: {} }), "m", fixed)?.occurred_at, "2026-01-01T00:00:00.000Z");
    assert.equal(parsePolarEvent(JSON.stringify({ type: "x", timestamp: "soon", data: {} }), "m", fixed)?.occurred_at, "2026-01-01T00:00:00.000Z");
  });
});

describe("the events the template subscribes to", () => {
  it("are exactly the ones the handler knows (scripts/polar-setup.mjs registers the same list)", () => {
    assert.deepEqual(
      [...POLAR_EVENTS].sort(),
      ["order.paid", "order.refunded", "order.updated", "subscription.active", "subscription.canceled", "subscription.created", "subscription.past_due", "subscription.revoked", "subscription.uncanceled", "subscription.updated"],
    );
  });
});
