/**
 * Self-heal: reads a customer's subscriptions and payments from the Paddle API and applies them the way the webhook would. The success page
 * calls it (through /api/billing/sync) while it waits for the webhook, and it repairs a delivery that was lost. Idempotent, and safe next to the
 * webhook: a subscription is only written if its Paddle `updated_at` is not older than what is stored.
 */
import { listCompletedTransactions, listSubscriptions } from "./api";
import { subscriptionRowFrom, transactionRowFrom, type BillingStore, type WebhookContext } from "./webhook";
import type { PaddleSubscription, PaddleTransaction } from "./types";

export interface SyncSource {
  listSubscriptions: (customerId: string) => Promise<(PaddleSubscription & { updated_at?: string })[]>;
  listCompletedTransactions: (customerId: string) => Promise<PaddleTransaction[]>;
}

export const paddleSyncSource: SyncSource = { listSubscriptions, listCompletedTransactions };

export async function syncCustomer(
  store: BillingStore,
  customerId: string,
  userId: string,
  ctx: WebhookContext,
  source: SyncSource = paddleSyncSource,
  now: () => string = () => new Date().toISOString(),
): Promise<{ subscriptions: number; transactions: number }> {
  let subscriptions = 0;
  let transactions = 0;
  for (const subscription of await source.listSubscriptions(customerId)) {
    const row = subscriptionRowFrom(subscription, userId, subscription.updated_at ?? now(), ctx);
    if ("ignored" in row) continue;
    await store.upsertSubscription(row);
    subscriptions += 1;
  }
  for (const transaction of await source.listCompletedTransactions(customerId)) {
    const row = transactionRowFrom(transaction, userId, ctx);
    if ("ignored" in row) continue;
    await store.upsertTransaction(row);
    transactions += 1;
  }
  return { subscriptions, transactions };
}
