/**
 * What a Polar webhook does to the database: Polar's payloads mapped to the provider-neutral rows (../types.ts), applied through a
 * `BillingStore`. Pure logic, tested without a database or a network: tests/polar-webhook.test.ts. The rules that keep it safe are listed in
 * ../delivery.ts; for Polar they mean:
 *
 *   - the user is `customer.external_id`, which only THIS server sets (it creates every checkout with `external_customer_id = userId`). A payload
 *     without one is ignored. Do not create public checkout links for these products in the Polar dashboard: they would not carry a userId.
 *   - a product that is not in `.env` (POLAR_PRODUCT_*) is ignored;
 *   - Polar is one organization per app (webhooks are per organization), so unlike Paddle there is no app tag.
 *
 * Events handled (`npm run polar:webhook` registers exactly these):
 *   subscription.created | updated | active | canceled | uncanceled | revoked | past_due   -> billing_subscriptions
 *   order.paid | updated | refunded                                                      -> billing_transactions (+ the refund, see below)
 * A refund shows up as the order's cumulative `refunded_amount` (+ `refunded_tax_amount`), kept as ONE adjustment per order that only grows:
 * Polar sends no other refund event we need, and the pull side (sync.ts) reads the same field.
 */
import type { CatalogItem } from "@/config/billing";
import { processDelivery } from "../delivery";
import type { AdjustmentRow, BillingStore, ProcessResult, SubscriptionRow, SubscriptionStatus, TransactionRow } from "../types";
import type { PolarCustomerRef, PolarEvent, PolarOrder, PolarSubscription } from "./types";

export interface PolarContext {
  /** Looks up which of our catalog items a Polar product id is (null: not ours). */
  itemForProductId: (productId: string | undefined | null) => CatalogItem | null;
}

const SUBSCRIPTION_EVENTS = new Set(["subscription.created", "subscription.updated", "subscription.active", "subscription.canceled", "subscription.uncanceled", "subscription.revoked", "subscription.past_due"]);
const ORDER_EVENTS = new Set(["order.paid", "order.updated", "order.refunded"]);

/** The Polar events `npm run polar:webhook` subscribes to. */
export const POLAR_EVENTS: readonly string[] = [...SUBSCRIPTION_EVENTS, ...ORDER_EVENTS];

/** Polar's subscription status as the neutral one. `incomplete` (no payment yet) is not mapped: nothing to grant. */
const STATUS: Record<string, SubscriptionStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  canceled: "canceled",
  unpaid: "canceled",
  incomplete_expired: "canceled",
};

/** An order that carries a payment (a refunded one was paid first; the refund is tracked apart). */
const PAID_STATUSES = new Set(["paid", "partially_refunded", "refunded"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Our user id: the external customer id the server set. Nothing else (metadata and e-mail are never trusted for this). A Supabase user id is a
 * UUID: anything else is not ours (another app that shares the Polar organization), and the database would refuse it with an error that no retry fixes.
 */
export function polarUid(customer: PolarCustomerRef | null | undefined): string | null {
  const id = customer?.external_id;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

const upper = (currency: string | null | undefined): string => (currency ?? "").toUpperCase();
const whole = (value: number | null | undefined): number => (typeof value === "number" && Number.isSafeInteger(value) ? value : 0);

/** The pure part of a subscription payload (webhook or API): the row to store, or why it is not ours. */
export function polarSubscriptionRowFrom(data: PolarSubscription, ctx: PolarContext): SubscriptionRow | { ignored: string } {
  const userId = polarUid(data.customer);
  if (!userId) return { ignored: "no_customer" };
  const item = ctx.itemForProductId(data.product_id);
  if (!item) return { ignored: "not_our_product" };
  const status = STATUS[data.status];
  if (!status) return { ignored: data.status === "incomplete" ? "not_started" : `unknown_status_${data.status}` };
  return {
    id: data.id,
    provider: "polar",
    user_id: userId,
    customer_id: data.customer_id ?? data.customer?.id ?? "",
    status,
    plan_key: item.kind === "plan" ? item.key : null,
    price_id: data.product_id,
    billing_interval: data.recurring_interval ?? null,
    quantity: data.seats && data.seats > 0 ? data.seats : 1,
    currency: data.currency ? upper(data.currency) : null,
    unit_amount: typeof data.amount === "number" ? whole(data.amount) : null,
    current_period_start: data.current_period_start ?? null,
    current_period_end: data.current_period_end ?? null,
    cancel_at_period_end: data.cancel_at_period_end === true,
    scheduled_change: null,
    canceled_at: data.canceled_at ?? null,
    event_occurred_at: data.modified_at ?? data.created_at,
  };
}

export interface PolarOrderRows {
  transaction: TransactionRow;
  /** The order's refund so far (null: nothing refunded). One per order, replaced by a newer state, never lowered by an older one. */
  refund: AdjustmentRow | null;
}

/** The pure part of an order payload (webhook or API): the rows to store, or why it is not ours. */
export function polarOrderRowsFrom(data: PolarOrder, ctx: PolarContext): PolarOrderRows | { ignored: string } {
  const userId = polarUid(data.customer);
  if (!userId) return { ignored: "no_customer" };
  const item = ctx.itemForProductId(data.product_id);
  if (!item) return { ignored: "not_our_product" };
  if (!PAID_STATUSES.has(data.status)) return { ignored: "not_paid" };

  const net = whole(data.net_amount);
  const tax = whole(data.tax_amount);
  const currency = upper(data.currency);
  const refunded = whole(data.refunded_amount) + whole(data.refunded_tax_amount);
  return {
    transaction: {
      id: data.id,
      provider: "polar",
      user_id: userId,
      customer_id: data.customer_id ?? data.customer?.id ?? "",
      subscription_id: data.subscription_id ?? null,
      status: "completed",
      origin: data.billing_reason ?? null,
      price_id: data.product_id ?? null,
      item_key: item.key,
      currency,
      subtotal: net,
      tax,
      total: data.total_amount === null || data.total_amount === undefined ? net + tax : whole(data.total_amount),
      invoice_number: data.invoice_number ?? null,
      billed_at: data.created_at,
    },
    refund:
      refunded > 0
        ? { id: `refund_${data.id}`, provider: "polar", transaction_id: data.id, user_id: userId, action: "refund", status: "approved", currency, total: refunded, event_occurred_at: data.modified_at ?? data.created_at }
        : null,
  };
}

/** Stores what an order says: the payment, and its refund so far. Shared by the webhook and the sync. */
export async function applyPolarOrder(store: BillingStore, rows: PolarOrderRows): Promise<void> {
  await store.upsertTransaction(rows.transaction);
  if (rows.refund) {
    await store.upsertAdjustment(rows.refund);
    await store.recomputeRefunded("polar", rows.transaction.id);
  }
}

/** Applies one verified event. Returns what it ended as, throws when it could not be applied (the caller answers 500, Polar retries). */
export async function applyPolarEvent(store: BillingStore, event: PolarEvent, ctx: PolarContext): Promise<ProcessResult> {
  if (SUBSCRIPTION_EVENTS.has(event.event_type)) {
    const row = polarSubscriptionRowFrom(event.data as PolarSubscription, ctx);
    if ("ignored" in row) return { status: "ignored", note: row.ignored };
    await store.upsertSubscription(row);
    return { status: "processed", note: `${event.event_type} ${row.status}` };
  }
  if (ORDER_EVENTS.has(event.event_type)) {
    const rows = polarOrderRowsFrom(event.data as PolarOrder, ctx);
    if ("ignored" in rows) return { status: "ignored", note: rows.ignored };
    await applyPolarOrder(store, rows);
    return { status: "processed", note: `${event.event_type} order recorded${rows.refund ? ", refunded" : ""}` };
  }
  return { status: "ignored", note: "unhandled_event_type" };
}

/** The whole delivery: claim (idempotency), apply, record the outcome. A duplicate is answered as a success without doing anything. */
export async function processPolarDelivery(store: BillingStore, event: PolarEvent, ctx: PolarContext): Promise<ProcessResult | { status: "duplicate" }> {
  return processDelivery(
    store,
    { provider: "polar", event_id: event.event_id, event_type: event.event_type, occurred_at: event.occurred_at, payload: event },
    () => applyPolarEvent(store, event, ctx),
  );
}

/** Polar's `{ type, timestamp, data }` body plus the `webhook-id` header. Returns null for a body that is not an event. */
export function parsePolarEvent(rawBody: string, eventId: string | null | undefined, now: () => string = () => new Date().toISOString()): PolarEvent | null {
  if (!eventId) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as { type?: unknown; timestamp?: unknown; data?: unknown };
  if (typeof body.type !== "string" || !body.data || typeof body.data !== "object") return null;
  const occurred = typeof body.timestamp === "string" && !Number.isNaN(Date.parse(body.timestamp)) ? body.timestamp : now();
  return { event_id: eventId, event_type: body.type, occurred_at: occurred, data: body.data };
}
