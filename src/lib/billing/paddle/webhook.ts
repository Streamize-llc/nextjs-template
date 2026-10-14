/**
 * What a Paddle webhook does to the database: Paddle's payloads mapped to the provider-neutral rows (../types.ts), applied through a
 * `BillingStore`. Pure logic, so every flow below is unit-tested without a database or a network: tests/paddle-webhook.test.ts. The rules that
 * keep it safe (who is credited, which items count, idempotency, order) are listed in ../delivery.ts; for Paddle they mean:
 *
 *   - the user is the one the server linked to the Paddle CUSTOMER id before the checkout opened (billing_customers + the index);
 *   - an event whose items are not in `.env` (PADDLE_PRICE_*), or whose custom data names another app, is ignored: the account is shared.
 */
import type { CatalogItem } from "@/config/billing";
import { processDelivery } from "../delivery";
import {
  SUBSCRIPTION_STATUSES,
  type AdjustmentRow,
  type BillingStore,
  type JsonObject,
  type ProcessResult,
  type SubscriptionRow,
  type SubscriptionStatus,
  type TransactionRow,
} from "../types";
import type { PaddleAdjustment, PaddleEvent, PaddleSubscription, PaddleTransaction } from "./types";

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

/** The Paddle events `npm run paddle:webhook` subscribes to: exactly the ones handled here (tests/billing-scripts.test.ts keeps the two lists equal). */
export const PADDLE_EVENTS: readonly string[] = [...SUBSCRIPTION_EVENTS, "transaction.completed", "adjustment.created", "adjustment.updated"];

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
    provider: "paddle",
    user_id: userId,
    customer_id: data.customer_id,
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
    provider: "paddle",
    user_id: userId,
    customer_id: data.customer_id ?? "",
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
  const userId = await store.userIdForCustomer("paddle", event.data.customer_id);
  if (!userId) return { status: "ignored", note: "unknown_customer" };
  const row = subscriptionRowFrom(event.data, userId, event.occurred_at, ctx);
  if ("ignored" in row) return { status: "ignored", note: row.ignored };
  await store.upsertSubscription(row);
  return { status: "processed", note: `${event.event_type} ${row.status}` };
}

async function applyTransaction(store: BillingStore, event: PaddleEvent<PaddleTransaction>, ctx: WebhookContext): Promise<ProcessResult> {
  if (!event.data.customer_id) return { status: "ignored", note: "no_customer" };
  const userId = await store.userIdForCustomer("paddle", event.data.customer_id);
  if (!userId) return { status: "ignored", note: "unknown_customer" };
  const row = transactionRowFrom(event.data, userId, ctx);
  if ("ignored" in row) return { status: "ignored", note: row.ignored };
  await store.upsertTransaction(row);
  return { status: "processed", note: "transaction recorded" };
}

async function applyAdjustment(store: BillingStore, event: PaddleEvent<PaddleAdjustment>): Promise<ProcessResult> {
  const transaction = await store.getTransaction("paddle", event.data.transaction_id);
  // An adjustment carries no custom data and no price: it is ours only if we recorded the payment it adjusts.
  if (!transaction) return { status: "ignored", note: "unknown_transaction" };
  const row: AdjustmentRow = {
    id: event.data.id,
    provider: "paddle",
    transaction_id: transaction.id,
    user_id: transaction.user_id,
    action: event.data.action,
    status: event.data.status,
    currency: event.data.currency_code ?? event.data.totals?.currency_code ?? "",
    total: minor(event.data.totals?.total),
    event_occurred_at: event.occurred_at,
  };
  await store.upsertAdjustment(row);
  await store.recomputeRefunded("paddle", transaction.id);
  return { status: "processed", note: `${event.data.action} ${event.data.status}` };
}

/** Applies one verified event. Returns what it ended as, throws when it could not be applied (the caller answers 500, Paddle retries). */
export async function applyPaddleEvent(store: BillingStore, event: PaddleEvent, ctx: WebhookContext): Promise<ProcessResult> {
  if (SUBSCRIPTION_EVENTS.has(event.event_type)) return applySubscription(store, event as unknown as PaddleEvent<PaddleSubscription>, ctx);
  if (event.event_type === "transaction.completed") return applyTransaction(store, event as unknown as PaddleEvent<PaddleTransaction>, ctx);
  if (event.event_type === "adjustment.created" || event.event_type === "adjustment.updated") return applyAdjustment(store, event as unknown as PaddleEvent<PaddleAdjustment>);
  return { status: "ignored", note: "unhandled_event_type" };
}

/** The whole delivery: claim (idempotency), apply, record the outcome. A duplicate is answered as a success without doing anything. */
export async function processPaddleDelivery(store: BillingStore, event: PaddleEvent, ctx: WebhookContext): Promise<ProcessResult | { status: "duplicate" }> {
  return processDelivery(
    store,
    { provider: "paddle", event_id: event.event_id, event_type: event.event_type, occurred_at: event.occurred_at ?? null, payload: event },
    () => applyPaddleEvent(store, event, ctx),
  );
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
