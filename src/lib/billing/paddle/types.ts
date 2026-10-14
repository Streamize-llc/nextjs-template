/**
 * The parts of Paddle Billing's payloads this template reads (the provider-neutral rows it writes are in ../types.ts).
 * Paddle sends money as strings of MINOR units ("999" = 9.99) and every field may be missing: everything optional is read defensively.
 * Reference: https://developer.paddle.com/webhooks/overview
 */
import type { JsonObject } from "../types";

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
