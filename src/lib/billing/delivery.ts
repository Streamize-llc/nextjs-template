/**
 * The part of a webhook delivery that is the same for every provider: claim it (idempotency), apply it, record the outcome. What "apply" means
 * is the provider's adapter (paddle/webhook.ts, polar/webhook.ts). Pure over a `BillingStore`: tests/billing-delivery.test.ts.
 *
 * The rules that keep this safe, on an account that is shared with other apps and that anybody on the internet can open a checkout on:
 *
 *   1. Who gets credited is decided by what the SERVER linked, never by anything the browser sent: the Paddle customer linked to the user
 *      before the checkout opened (billing_customers), or the userId the server set as the Polar customer's external id. A payment from a
 *      customer we do not know is ignored.
 *   2. Only OUR items count: an id that is not in `.env` (PADDLE_PRICE_*, POLAR_PRODUCT_*) belongs to another app or to nobody: ignored.
 *   3. Events are idempotent (providers deliver at least once) and may arrive out of order: an older state never overwrites a newer one.
 *   4. A failure throws, the route answers 500 and the provider delivers again later. Ignoring is a decision, never an accident.
 */
import { UnknownUserError, type BillingStore, type ProcessResult, type WebhookEventRecord } from "./types";

export async function processDelivery(
  store: BillingStore,
  event: WebhookEventRecord,
  apply: () => Promise<ProcessResult>,
): Promise<ProcessResult | { status: "duplicate" }> {
  const claimed = await store.claimEvent(event);
  if (!claimed) return { status: "duplicate" };
  try {
    let result: ProcessResult;
    try {
      result = await apply();
    } catch (error) {
      // A payment of a user who was deleted: nothing to credit, and a retry can never change that.
      if (!(error instanceof UnknownUserError)) throw error;
      result = { status: "ignored", note: "unknown_user" };
    }
    await store.finishEvent(event.provider, event.event_id, result.status, result.note);
    return result;
  } catch (error) {
    await store.failEvent(event.provider, event.event_id, error instanceof Error ? error.message : String(error)).catch(() => undefined);
    throw error;
  }
}
