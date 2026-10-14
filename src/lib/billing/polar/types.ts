/**
 * The parts of Polar's payloads this template reads, in Polar's own snake_case wire format (the same objects come from the webhooks and from
 * the REST API). Every field may be missing or null: everything optional is read defensively. The provider-neutral rows it writes are in
 * ../types.ts. Reference: https://docs.polar.sh/api-reference
 */

export interface PolarCustomerRef {
  id?: string | null;
  /** The id of the customer in OUR system: the Firebase userId the server set when it created the checkout. */
  external_id?: string | null;
  email?: string | null;
}

export interface PolarSubscription {
  id: string;
  /** incomplete | incomplete_expired | trialing | active | past_due | canceled | unpaid */
  status: string;
  amount?: number | null;
  currency?: string | null;
  recurring_interval?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean | null;
  canceled_at?: string | null;
  ends_at?: string | null;
  ended_at?: string | null;
  created_at: string;
  modified_at?: string | null;
  customer_id?: string | null;
  product_id: string;
  seats?: number | null;
  customer?: PolarCustomerRef | null;
}

export interface PolarOrder {
  id: string;
  /** pending | paid | refunded | partially_refunded | void */
  status: string;
  paid?: boolean | null;
  /** purchase | subscription_create | subscription_cycle | subscription_update */
  billing_reason?: string | null;
  currency: string;
  /** Before tax. */
  net_amount: number;
  tax_amount?: number | null;
  /** What the buyer was charged, tax included. */
  total_amount?: number | null;
  refunded_amount?: number | null;
  refunded_tax_amount?: number | null;
  invoice_number?: string | null;
  created_at: string;
  modified_at?: string | null;
  customer_id?: string | null;
  product_id?: string | null;
  subscription_id?: string | null;
  customer?: PolarCustomerRef | null;
}

/** A webhook delivery after parsing: Polar's `{ type, timestamp, data }` body plus the `webhook-id` header. */
export interface PolarEvent<T = unknown> {
  /** The `webhook-id` header: the same for every redelivery of the same message. */
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: T;
}
