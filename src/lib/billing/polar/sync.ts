/**
 * Self-heal: reads a user's subscriptions and orders from the Polar API and applies them the way the webhooks would. The success page calls it
 * (through /api/billing/sync) while it waits for the webhook, and it repairs a delivery that was lost. Idempotent, and safe next to the
 * webhooks: a subscription or a refund is only written if its `modified_at` is not older than what is stored.
 */
import type { BillingStore } from "../types";
import { listOrders, listSubscriptions } from "./api";
import type { PolarOrder, PolarSubscription } from "./types";
import { applyPolarOrder, polarOrderRowsFrom, polarSubscriptionRowFrom, type PolarContext } from "./webhook";

export interface PolarSyncSource {
  listSubscriptions: (userId: string) => Promise<PolarSubscription[]>;
  listOrders: (userId: string) => Promise<PolarOrder[]>;
}

export const polarSyncSource: PolarSyncSource = { listSubscriptions, listOrders };

export async function syncPolarCustomer(
  store: BillingStore,
  userId: string,
  ctx: PolarContext,
  source: PolarSyncSource = polarSyncSource,
): Promise<{ subscriptions: number; transactions: number }> {
  let subscriptions = 0;
  let transactions = 0;
  for (const subscription of await source.listSubscriptions(userId)) {
    // The list is filtered by this user's external id already; checking again costs nothing and keeps a wrong answer from crediting anybody else.
    if (subscription.customer?.external_id !== userId) continue;
    const row = polarSubscriptionRowFrom(subscription, ctx);
    if ("ignored" in row) continue;
    await store.upsertSubscription(row);
    subscriptions += 1;
  }
  for (const order of await source.listOrders(userId)) {
    if (order.customer?.external_id !== userId) continue;
    const rows = polarOrderRowsFrom(order, ctx);
    if ("ignored" in rows) continue;
    await applyPolarOrder(store, rows);
    transactions += 1;
  }
  return { subscriptions, transactions };
}
