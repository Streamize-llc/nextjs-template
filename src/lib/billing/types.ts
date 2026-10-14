/**
 * The provider-neutral shapes of the billing module: what a webhook or a sync turns a payment provider's payload INTO, and what is stored.
 * Paddle and Polar each have an adapter (`paddle/`, `polar/`) that maps its own payloads to these rows; everything after that (the store, the
 * entitlement, the pages, the routes) only knows these, so a user can have a Paddle subscription today and a Polar one next year.
 *
 * Dates are ISO 8601 strings; money is MINOR units (cents) as numbers. `provider` is on every row, and the primary key of every table is
 * (`provider`, `id`), so a Paddle id and a Polar id can never collide.
 */
import type { BillingProviderName } from "@/config/billing";

export type Provider = BillingProviderName;

/** What the functions that read the environment take: `process.env`, or any plain object (the tests pass one). */
export type Env = Record<string, string | undefined>;

export type JsonObject = Record<string, unknown>;

export const SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "paused", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface SubscriptionRow {
  /** The provider's own id of the subscription. */
  id: string;
  provider: Provider;
  user_id: string;
  /** The provider's id of the customer (Paddle `ctm_...`, Polar's customer uuid). */
  customer_id: string;
  status: SubscriptionStatus;
  plan_key: string | null;
  /** What was bought, in the provider's terms: a Paddle price id, a Polar product id. */
  price_id: string;
  billing_interval: string | null;
  quantity: number;
  currency: string | null;
  unit_amount: number | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  scheduled_change: JsonObject | null;
  canceled_at: string | null;
  /** When the provider produced this state. An older state never overwrites a newer one (compared as instants). */
  event_occurred_at: string;
}

export interface TransactionRow {
  id: string;
  provider: Provider;
  user_id: string;
  customer_id: string;
  subscription_id: string | null;
  /** `completed` for a payment that went through (a refund shows in `refunded`, not here). */
  status: string;
  origin: string | null;
  price_id: string | null;
  item_key: string | null;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  invoice_number: string | null;
  billed_at: string | null;
}

/** A refund or a chargeback against a transaction. `approved` ones are what `billing_transactions.refunded` adds up. */
export interface AdjustmentRow {
  id: string;
  provider: Provider;
  transaction_id: string;
  user_id: string;
  action: string;
  status: string;
  currency: string;
  total: number;
  /** When the provider produced this state: a late older delivery must not undo a newer one (a refund that was approved stays approved). */
  event_occurred_at: string;
}

export interface WebhookEventRecord {
  provider: Provider;
  /** The provider's id of the delivery: Paddle `evt_...`, Polar's `webhook-id` header. */
  event_id: string;
  event_type: string;
  occurred_at: string | null;
  payload: unknown;
}

/**
 * The row belongs to a user that does not exist (any more): a payment or a renewal for an account that was deleted. The store throws this on the
 * database's foreign key violation (23503); a delivery answers it with "ignored", because a retry can never fix it (an error would make the provider
 * redeliver for days).
 */
export class UnknownUserError extends Error {
  constructor() {
    super("the user of this payment does not exist (any more)");
    this.name = "UnknownUserError";
  }
}

/** What a webhook delivery ended as. Never an error: errors are thrown so the provider redelivers. */
export interface ProcessResult {
  status: "processed" | "ignored";
  note: string;
}

/** What a webhook needs from storage. `supabaseBillingStore` (store.ts) is the implementation; the tests use a fake. */
export interface BillingStore {
  /** Records the delivery. True when THIS call should process it: new, or an earlier attempt failed or went stale. False for a duplicate. */
  claimEvent(event: WebhookEventRecord): Promise<boolean>;
  finishEvent(provider: Provider, eventId: string, status: "processed" | "ignored", note: string): Promise<void>;
  failEvent(provider: Provider, eventId: string, message: string): Promise<void>;

  /** Which user a provider customer was linked to by the server (Paddle: customers are found by e-mail, so the link is ours; Polar: always null, its payload carries the user id). */
  userIdForCustomer(provider: Provider, customerId: string): Promise<string | null>;
  /** Insert, or update only if `row.event_occurred_at` is not older than what is stored. */
  upsertSubscription(row: SubscriptionRow): Promise<void>;
  upsertTransaction(row: TransactionRow): Promise<void>;
  getTransaction(provider: Provider, id: string): Promise<{ id: string; user_id: string } | null>;
  /** Insert, or update only if `row.event_occurred_at` is not older than what is stored. */
  upsertAdjustment(row: AdjustmentRow): Promise<void>;
  /** Recomputes `billing_transactions.refunded` from the approved refunds and chargebacks of that transaction. */
  recomputeRefunded(provider: Provider, transactionId: string): Promise<void>;
}
