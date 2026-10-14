/**
 * What a Paddle webhook does to the database. Pure logic over a `BillingStore` (src/lib/paddle/store.ts is the Supabase one), so every
 * flow below is unit-tested without a database or a network: tests/paddle-webhook.test.ts.
 *
 * The rules that keep this safe on an account that is shared with other apps and that anybody on the internet can open a checkout on:
 *
 *   1. Who gets credited is decided by the Paddle CUSTOMER id, which the server linked to a user before the checkout opened
 *      (billing_customers). Nothing the browser sends (custom data, e-mail) decides it. A payment from a customer we do not know is ignored.
 *   2. Only OUR prices count: an event whose items are not in `.env` (PADDLE_PRICE_*) belongs to another app or to nobody, and is ignored.
 *   3. Events are idempotent (Paddle delivers at least once) and may arrive out of order: an older subscription event never overwrites a
 *      newer one (billing_subscriptions.event_occurred_at).
 *   4. A failure throws, the route answers 500 and Paddle delivers again later. Ignoring is a decision, never an accident.
 */
import type { CatalogItem } from "@/config/billing";
import {
  SUBSCRIPTION_STATUSES,
  type AdjustmentRow,
  type JsonObject,
  type PaddleAdjustment,
  type PaddleEvent,
  type PaddleSubscription,
  type PaddleTransaction,
  type ProcessResult,
  type SubscriptionRow,
  type SubscriptionStatus,
  type TransactionRow,
  type WebhookEventRecord,
} from "./types";

export interface BillingStore {
  /** Records the delivery. True when THIS call should process it: new, or an earlier attempt failed or went stale. False for a duplicate. */
  claimEvent(event: WebhookEventRecord): Promise<boolean>;
  finishEvent(eventId: string, status: "processed" | "ignored", note: string): Promise<void>;
  failEvent(eventId: string, message: string): Promise<void>;

  userIdForCustomer(customerId: string): Promise<string | null>;
  /** Insert, or update only if `row.event_occurred_at` is not older than what is stored. */
  upsertSubscription(row: SubscriptionRow): Promise<void>;
  upsertTransaction(row: TransactionRow): Promise<void>;
  getTransaction(id: string): Promise<{ id: string; user_id: string } | null>;
  upsertAdjustment(row: AdjustmentRow): Promise<void>;
  /** Recomputes `billing_transactions.refunded` from the approved refunds and chargebacks of that transaction. */
  recomputeRefunded(transactionId: string): Promise<void>;
}

export interface WebhookContext {
  /** Looks up which of our catalog items a Paddle price id is (null: not ours). */
  itemForPriceId: (priceId: string | undefined | null) => CatalogItem | null;
  appTag: string;
}

const SUBSCRIPTION_EVENTS = new Set([
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.canceled",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
]);

/** Paddle money is a string of minor units. Anything that is not a whole number counts as 0 rather than breaking the whole event. */
export function minor(value: unknown): number {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) ? n : 0;
}

function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/** True when the payload says it was made by a DIFFERENT app of ours on the same Paddle account. A payload with no tag at all is not foreign. */
function isForeign(customData: JsonObject | null | undefined, appTag: string): boolean {
  const tag = customData?.app;
  return typeof tag === "string" && tag !== appTag;
}

/** The pure part of a subscription event: the row to store, or why it is not ours. `userId` comes from the customer link. */
export function subscriptionRowFrom(data: PaddleSubscription, userId: string, occurredAt: string, ctx: WebhookContext): SubscriptionRow | { ignored: string } {
  if (isForeign(data.custom_data, ctx.appTag)) return { ignored: "other_app" };
  const priced = (data.items ?? []).map((entry) => ({ entry, item: ctx.itemForPriceId(entry.price?.id) })).find((candidate) => candidate.item);
  if (!priced?.item || !priced.entry.price) return { ignored: "not_our_price" };
  if (!isSubscriptionStatus(data.status)) return { ignored: `unknown_status_${data.status}` };
  const price = priced.entry.price;
  const change = data.scheduled_change ?? null;
  return {
    id: data.id,
    user_id: userId,
    paddle_customer_id: data.customer_id,
    status: data.status,
    plan_key: priced.item.kind === "plan" ? priced.item.key : null,
    price_id: price.id,
    billing_interval: data.billing_cycle?.interval ?? price.billing_cycle?.interval ?? null,
    quantity: priced.entry.quantity ?? 1,
    currency: data.currency_code ?? price.unit_price?.currency_code ?? null,
    unit_amount: price.unit_price?.amount === undefined ? null : minor(price.unit_price.amount),
    current_period_start: data.current_billing_period?.starts_at ?? null,
    current_period_end: data.current_billing_period?.ends_at ?? null,
    cancel_at_period_end: change?.action === "cancel",
    scheduled_change: change ? (change as JsonObject) : null,
    canceled_at: data.canceled_at ?? null,
    event_occurred_at: occurredAt,
  };
}

/** The pure part of `transaction.completed`: the row to store, or why it is not ours. */
export function transactionRowFrom(data: PaddleTransaction, userId: string, ctx: WebhookContext): TransactionRow | { ignored: string } {
  if (isForeign(data.custom_data, ctx.appTag)) return { ignored: "other_app" };
  const priced = (data.items ?? []).map((entry) => ({ entry, item: ctx.itemForPriceId(entry.price_id ?? entry.price?.id) })).find((candidate) => candidate.item);
  if (!priced?.item) return { ignored: "not_our_price" };
  const totals = data.details?.totals;
  return {
    id: data.id,
    user_id: userId,
    paddle_customer_id: data.customer_id ?? "",
    subscription_id: data.subscription_id ?? null,
    status: data.status,
    origin: data.origin ?? null,
    price_id: priced.entry.price_id ?? priced.entry.price?.id ?? null,
    item_key: priced.item.key,
    currency: data.currency_code ?? totals?.currency_code ?? "",
    subtotal: minor(totals?.subtotal),
    tax: minor(totals?.tax),
    total: minor(totals?.grand_total ?? totals?.total),
    invoice_number: data.invoice_number ?? null,
    billed_at: data.billed_at ?? null,
  };
}

async function applySubscription(store: BillingStore, event: PaddleEvent<PaddleSubscription>, ctx: WebhookContext): Promise<ProcessResult> {
  const userId = await store.userIdForCustomer(event.data.customer_id);
  if (!userId) return { status: "ignored", note: "unknown_customer" };
  const row = subscriptionRowFrom(event.data, userId, event.occurred_at, ctx);
  if ("ignored" in row) return { status: "ignored", note: row.ignored };
  await store.upsertSubscription(row);
  return { status: "processed", note: `${event.event_type} ${row.status}` };
}

async function applyTransaction(store: BillingStore, event: PaddleEvent<PaddleTransaction>, ctx: WebhookContext): Promise<ProcessResult> {
  if (!event.data.customer_id) return { status: "ignored", note: "no_customer" };
  const userId = await store.userIdForCustomer(event.data.customer_id);
  if (!userId) return { status: "ignored", note: "unknown_customer" };
  const row = transactionRowFrom(event.data, userId, ctx);
  if ("ignored" in row) return { status: "ignored", note: row.ignored };
  await store.upsertTransaction(row);
  return { status: "processed", note: "transaction recorded" };
}

async function applyAdjustment(store: BillingStore, event: PaddleEvent<PaddleAdjustment>): Promise<ProcessResult> {
  const transaction = await store.getTransaction(event.data.transaction_id);
  // An adjustment carries no custom data and no price: it is ours only if we recorded the payment it adjusts.
  if (!transaction) return { status: "ignored", note: "unknown_transaction" };
  await store.upsertAdjustment({
    id: event.data.id,
    transaction_id: transaction.id,
    user_id: transaction.user_id,
    action: event.data.action,
    status: event.data.status,
    currency: event.data.currency_code ?? event.data.totals?.currency_code ?? "",
    total: minor(event.data.totals?.total),
  });
  await store.recomputeRefunded(transaction.id);
  return { status: "processed", note: `${event.data.action} ${event.data.status}` };
}

/** Applies one verified event. Returns what it ended as, throws when it could not be applied (the caller answers 500, Paddle retries). */
export async function applyPaddleEvent(store: BillingStore, event: PaddleEvent, ctx: WebhookContext): Promise<ProcessResult> {
  if (SUBSCRIPTION_EVENTS.has(event.event_type)) return applySubscription(store, event as unknown as PaddleEvent<PaddleSubscription>, ctx);
  if (event.event_type === "transaction.completed") return applyTransaction(store, event as unknown as PaddleEvent<PaddleTransaction>, ctx);
  if (event.event_type === "adjustment.created" || event.event_type === "adjustment.updated") return applyAdjustment(store, event as unknown as PaddleEvent<PaddleAdjustment>);
  return { status: "ignored", note: "unhandled_event_type" };
}

/**
 * The whole delivery: claim (idempotency), apply, record the outcome. A duplicate is answered as a success without doing anything.
 * An error is recorded and re-thrown, so the delivery is retried.
 */
export async function processPaddleDelivery(store: BillingStore, event: PaddleEvent, ctx: WebhookContext): Promise<ProcessResult | { status: "duplicate" }> {
  const claimed = await store.claimEvent({ event_id: event.event_id, event_type: event.event_type, occurred_at: event.occurred_at ?? null, payload: event });
  if (!claimed) return { status: "duplicate" };
  try {
    const result = await applyPaddleEvent(store, event, ctx);
    await store.finishEvent(event.event_id, result.status, result.note);
    return result;
  } catch (error) {
    await store.failEvent(event.event_id, error instanceof Error ? error.message : String(error)).catch(() => undefined);
    throw error;
  }
}

/** The shape every Paddle event has, checked before anything else. Returns null for a body that is not an event. */
export function parsePaddleEvent(rawBody: string): PaddleEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const event = parsed as Partial<PaddleEvent>;
  if (typeof event.event_id !== "string" || typeof event.event_type !== "string" || typeof event.occurred_at !== "string") return null;
  if (!event.data || typeof event.data !== "object") return null;
  if (Number.isNaN(Date.parse(event.occurred_at))) return null;
  return event as PaddleEvent;
}
