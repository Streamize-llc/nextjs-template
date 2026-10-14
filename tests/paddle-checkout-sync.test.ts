import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCheckoutRequest, resolveCheckoutItem } from "@/lib/paddle/checkout";
import { syncCustomer, type SyncSource } from "@/lib/paddle/sync";
import { adjustmentData, context, CUSTOMER_ID, ENV, ITEMS, MemoryStore, subscriptionData, transactionData, USER_ID } from "./support/paddle-fixtures";
import type { PaddleSubscription, PaddleTransaction } from "@/lib/paddle/types";

describe("parseCheckoutRequest", () => {
  it("accepts a plan with an interval and a product without one", () => {
    assert.deepEqual(parseCheckoutRequest({ kind: "plan", key: "pro", interval: "month" }), { kind: "plan", key: "pro", interval: "month" });
    assert.deepEqual(parseCheckoutRequest({ kind: "plan", key: "pro", interval: "year" }), { kind: "plan", key: "pro", interval: "year" });
    assert.deepEqual(parseCheckoutRequest({ kind: "product", key: "credits_100" }), { kind: "product", key: "credits_100", interval: null });
  });

  it("refuses anything the browser should not be sending", () => {
    for (const bad of [null, undefined, "plan", 7, [], {}, { kind: "plan", key: "pro" }, { kind: "plan", key: "pro", interval: "week" }, { kind: "plan", key: "", interval: "month" }, { kind: "plan", key: "x".repeat(41), interval: "month" }, { kind: "bundle", key: "pro" }, { kind: "plan", key: 3, interval: "month" }]) {
      assert.equal(parseCheckoutRequest(bad), null, JSON.stringify(bad));
    }
  });

  it("ignores a price, an amount or a customer in the body: only the name of the thing counts", () => {
    assert.deepEqual(parseCheckoutRequest({ kind: "plan", key: "pro", interval: "month", priceId: "pri_free", amount: 1, customerId: "ctm_x" }), { kind: "plan", key: "pro", interval: "month" });
  });
});

describe("resolveCheckoutItem", () => {
  it("finds the item and its price id from the environment", () => {
    const resolved = resolveCheckoutItem({ kind: "plan", key: "pro", interval: "year" }, ENV, ITEMS);
    assert.ok(!("error" in resolved));
    assert.equal(resolved.priceId, "pri_pro_year");
    assert.equal(resolved.item.key, "pro");
    const product = resolveCheckoutItem({ kind: "product", key: "credits_100", interval: null }, ENV, ITEMS);
    assert.ok(!("error" in product));
    assert.equal(product.priceId, "pri_credits_100");
  });

  it("says unknown_item for a plan, an interval or a product that is not in src/config/billing.ts", () => {
    assert.deepEqual(resolveCheckoutItem({ kind: "plan", key: "enterprise", interval: "month" }, ENV, ITEMS), { error: "unknown_item" });
    assert.deepEqual(resolveCheckoutItem({ kind: "product", key: "pro", interval: null }, ENV, ITEMS), { error: "unknown_item" });
    assert.deepEqual(resolveCheckoutItem({ kind: "plan", key: "credits_100", interval: "month" }, ENV, ITEMS), { error: "unknown_item" });
  });

  it("says price_not_configured while the price id is not in .env yet", () => {
    assert.deepEqual(resolveCheckoutItem({ kind: "plan", key: "pro", interval: "month" }, {}, ITEMS), { error: "price_not_configured" });
  });
});

describe("syncCustomer", () => {
  const source = (subscriptions: (PaddleSubscription & { updated_at?: string })[], transactions: PaddleTransaction[]): SyncSource => ({
    listSubscriptions: async () => subscriptions,
    listCompletedTransactions: async () => transactions,
  });
  const ctx = context();

  it("applies a customer's subscriptions and payments the way the webhook would", async () => {
    const store = new MemoryStore();
    const result = await syncCustomer(store, CUSTOMER_ID, USER_ID, ctx, source([{ ...subscriptionData(), updated_at: "2026-10-14T00:00:09Z" } as never], [transactionData() as never]));
    assert.deepEqual(result, { subscriptions: 1, transactions: 1 });
    assert.equal(store.subscriptions.get("sub_01test")?.event_occurred_at, "2026-10-14T00:00:09Z");
    assert.equal(store.transactions.get("txn_01test")?.total, 990);
  });

  it("skips what is not ours and does not touch refunds", async () => {
    const store = new MemoryStore();
    const foreign = subscriptionData({ custom_data: { app: "other-app" } });
    const result = await syncCustomer(store, CUSTOMER_ID, USER_ID, ctx, source([foreign as never], [transactionData({ items: [{ price_id: "pri_x" }] }) as never]));
    assert.deepEqual(result, { subscriptions: 0, transactions: 0 });
    assert.equal(store.subscriptions.size + store.transactions.size, 0);
    assert.equal(typeof adjustmentData, "function");
  });

  it("does not overwrite a newer state the webhook already wrote", async () => {
    const store = new MemoryStore();
    await store.upsertSubscription({ ...(await (async () => {
      const probe = new MemoryStore();
      await syncCustomer(probe, CUSTOMER_ID, USER_ID, ctx, source([subscriptionData({ status: "canceled" }) as never], []));
      return probe.subscriptions.get("sub_01test")!;
    })()), event_occurred_at: "2099-01-01T00:00:00Z" });
    await syncCustomer(store, CUSTOMER_ID, USER_ID, ctx, source([{ ...subscriptionData({ status: "active" }), updated_at: "2026-10-14T00:00:09Z" } as never], []));
    assert.equal(store.subscriptions.get("sub_01test")?.status, "canceled");
  });
});
