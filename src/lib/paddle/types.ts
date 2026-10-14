/**
 * The parts of Paddle Billing's payloads this template reads, and the database rows it writes.
 * Paddle sends money as strings of MINOR units ("999" = 9.99) and every field may be missing: everything optional is read defensively.
 * Reference: https://developer.paddle.com/webhooks/overview
 */

export type JsonObject = Record<string, unknown>;

export interface PaddleEvent<T = JsonObject> {
  event_id: string;
  event_type: string;
  occurred_at: string;
  notification_id?: string;
  data: T;
}

export interface PaddlePrice {
  id: string;
  product_id?: string;
  unit_price?: { amount?: string; currency_code?: string };
  billing_cycle?: { interval?: string; frequency?: number } | null;
}

export interface PaddleSubscription {
  id: string;
  status: string;
  customer_id: string;
  currency_code?: string;
  custom_data?: JsonObject | null;
  canceled_at?: string | null;
  current_billing_period?: { starts_at?: string; ends_at?: string } | null;
  billing_cycle?: { interval?: string; frequency?: number } | null;
  scheduled_change?: { action?: string; effective_at?: string; resume_at?: string | null } | null;
  items?: { quantity?: number; recurring?: boolean; price?: PaddlePrice }[];
}

export interface PaddleTransaction {
  id: string;
  status: string;
  customer_id?: string | null;
  subscription_id?: string | null;
  origin?: string;
  currency_code?: string;
  custom_data?: JsonObject | null;
  invoice_number?: string | null;
  billed_at?: string | null;
  items?: { quantity?: number; price_id?: string; price?: PaddlePrice }[];
  details?: { totals?: { subtotal?: string; tax?: string; total?: string; grand_total?: string; currency_code?: string } };
}

export interface PaddleAdjustment {
  id: string;
  action: string;
  status: string;
  transaction_id: string;
  customer_id?: string | null;
  currency_code?: string;
  totals?: { total?: string; currency_code?: string };
}

export const SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "paused", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface SubscriptionRow {
  id: string;
  user_id: string;
  paddle_customer_id: string;
  status: SubscriptionStatus;
  plan_key: string | null;
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
  event_occurred_at: string;
}

export interface TransactionRow {
  id: string;
  user_id: string;
  paddle_customer_id: string;
  subscription_id: string | null;
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

export interface AdjustmentRow {
  id: string;
  transaction_id: string;
  user_id: string;
  action: string;
  status: string;
  currency: string;
  total: number;
}

export interface WebhookEventRecord {
  event_id: string;
  event_type: string;
  occurred_at: string | null;
  payload: unknown;
}

/** What a webhook delivery ended as. Never an error: errors are thrown so Paddle redelivers. */
export interface ProcessResult {
  status: "processed" | "ignored";
  note: string;
}
