import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PaddleSubscription, PaddleTransaction } from "@/lib/billing/paddle/types";
import { syncPaddleCustomer, type SyncSource } from "@/lib/billing/paddle/sync";
import { context, CUSTOMER_ID, MemoryStore, subscriptionData, transactionData, USER_ID } from "./support/billing-fixtures";

describe("syncPaddleCustomer", () => {
  const source = (subscriptions: (PaddleSubscription & { updated_at?: string })[], transactions: PaddleTransaction[]): SyncSource => ({
    listSubscriptions: async () => subscriptions,
    listCompletedTransactions: async () => transactions,
  });
  const ctx = context();

  it("applies a customer's subscriptions and payments the way the webhook would", async () => {
    const store = new MemoryStore();
    const result = await syncPaddleCustomer(store, CUSTOMER_ID, USER_ID, ctx, source([{ ...subscriptionData(), updated_at: "2026-10-14T00:00:09Z" } as never], [transactionData() as never]));
    assert.deepEqual(result, { subscriptions: 1, transactions: 1 });
    assert.equal(store.subscriptions.get("paddle_sub_01test")?.event_occurred_at, "2026-10-14T00:00:09Z");
    assert.equal(store.transactions.get("paddle_txn_01test")?.total, 990);
  });

  it("skips what is not ours", async () => {
    const store = new MemoryStore();
    const foreign = subscriptionData({ custom_data: { app: "other-app" } });
    const result = await syncPaddleCustomer(store, CUSTOMER_ID, USER_ID, ctx, source([foreign as never], [transactionData({ items: [{ price_id: "pri_x" }] }) as never]));
    assert.deepEqual(result, { subscriptions: 0, transactions: 0 });
    assert.equal(store.subscriptions.size + store.transactions.size, 0);
  });

  it("does not overwrite a newer state the webhook already wrote", async () => {
    const store = new MemoryStore();
    const probe = new MemoryStore();
    await syncPaddleCustomer(probe, CUSTOMER_ID, USER_ID, ctx, source([subscriptionData({ status: "canceled" }) as never], []));
    await store.upsertSubscription({ ...probe.subscriptions.get("paddle_sub_01test")!, event_occurred_at: "2099-01-01T00:00:00Z" });
    await syncPaddleCustomer(store, CUSTOMER_ID, USER_ID, ctx, source([{ ...subscriptionData({ status: "active" }), updated_at: "2026-10-14T00:00:09Z" } as never], []));
    assert.equal(store.subscriptions.get("paddle_sub_01test")?.status, "canceled");
  });
});
