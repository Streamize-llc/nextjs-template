import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PolarOrder, PolarSubscription } from "@/lib/billing/polar/types";
import { syncPolarCustomer, type PolarSyncSource } from "@/lib/billing/polar/sync";
import { MemoryStore, OTHER_USER_ID, polarContext, polarCustomer, polarOrderData, polarSubscriptionData, USER_ID } from "./support/billing-fixtures";

const SUB = "polar_6a1f0c52-0000-4000-8000-0000000000a1";
const ORDER = "polar_9d2e7a10-0000-4000-8000-0000000000b1";
const ctx = polarContext();
const source = (subscriptions: unknown[], orders: unknown[]): PolarSyncSource => ({
  listSubscriptions: async () => subscriptions as PolarSubscription[],
  listOrders: async () => orders as PolarOrder[],
});

describe("syncPolarCustomer", () => {
  it("applies a user's subscriptions and orders the way the webhooks would, refunds included", async () => {
    const store = new MemoryStore();
    const refunded = polarOrderData({ status: "partially_refunded", refunded_amount: 300, refunded_tax_amount: 30, modified_at: "2026-10-15T00:00:00Z" });
    const result = await syncPolarCustomer(store, USER_ID, ctx, source([polarSubscriptionData()], [refunded]));
    assert.deepEqual(result, { subscriptions: 1, transactions: 1 });
    assert.equal(store.subscriptions.get(SUB)?.status, "active");
    assert.equal(store.transactions.get(ORDER)?.refunded, 330);
  });

  it("skips what is not ours: another product, an unpaid order, and anybody else's object", async () => {
    const store = new MemoryStore();
    const result = await syncPolarCustomer(
      store,
      USER_ID,
      ctx,
      source(
        [polarSubscriptionData({ product_id: "prod_x" }), polarSubscriptionData({ id: "other", customer: polarCustomer(OTHER_USER_ID) })],
        [polarOrderData({ status: "pending" }), polarOrderData({ id: "o2", customer: polarCustomer(OTHER_USER_ID) })],
      ),
    );
    assert.deepEqual(result, { subscriptions: 0, transactions: 0 });
    assert.equal(store.subscriptions.size + store.transactions.size, 0);
  });

  it("does not overwrite a newer state a webhook already wrote", async () => {
    const store = new MemoryStore();
    await store.upsertSubscription({ ...(polarRow("canceled")), event_occurred_at: "2099-01-01T00:00:00Z" });
    await syncPolarCustomer(store, USER_ID, ctx, source([polarSubscriptionData({ status: "active" })], []));
    assert.equal(store.subscriptions.get(SUB)?.status, "canceled");
  });
});

function polarRow(status: "canceled" | "active") {
  return {
    id: "6a1f0c52-0000-4000-8000-0000000000a1",
    provider: "polar" as const,
    user_id: USER_ID,
    customer_id: "c",
    status,
    plan_key: "pro",
    price_id: "prod_pro_month",
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
  };
}
