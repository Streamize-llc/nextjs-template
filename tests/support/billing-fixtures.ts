// Shared by the billing tests: payload builders shaped like Paddle's and Polar's real webhooks, and an in-memory BillingStore that follows
// the same rules as the Supabase one (a duplicate is not processed twice, an older subscription or refund never overwrites a newer one).
import { billingConfig, catalogItems } from "@/config/billing";
import { itemForProviderRef } from "@/lib/billing/catalog";
import type { PaddleEvent } from "@/lib/billing/paddle/types";
import type { WebhookContext } from "@/lib/billing/paddle/webhook";
import type { PolarEvent } from "@/lib/billing/polar/types";
import type { PolarContext } from "@/lib/billing/polar/webhook";
import type { AdjustmentRow, BillingStore, JsonObject, Provider, SubscriptionRow, TransactionRow, WebhookEventRecord } from "@/lib/billing/types";

export const APP_TAG = "test-app";
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
export const CUSTOMER_ID = "ctm_01testcustomer";
export const POLAR_CUSTOMER_ID = "0b1c2d3e-0000-4000-8000-000000000001";

/** The Paddle price ids "in .env": the plans of src/config/billing.ts plus one one-time product. */
export const ENV = {
  PADDLE_PRICE_PRO_MONTH: "pri_pro_month",
  PADDLE_PRICE_PRO_YEAR: "pri_pro_year",
  PADDLE_PRICE_TEAM_MONTH: "pri_team_month",
  PADDLE_PRICE_TEAM_YEAR: "pri_team_year",
  PADDLE_PRICE_CREDITS_100: "pri_credits_100",
};

/** The Polar product ids "in .env": the same catalog. */
export const POLAR_ENV = {
  POLAR_PRODUCT_PRO_MONTH: "prod_pro_month",
  POLAR_PRODUCT_PRO_YEAR: "prod_pro_year",
  POLAR_PRODUCT_TEAM_MONTH: "prod_team_month",
  POLAR_PRODUCT_TEAM_YEAR: "prod_team_year",
  POLAR_PRODUCT_CREDITS_100: "prod_credits_100",
};

export const ITEMS = catalogItems({
  plans: billingConfig.plans,
  products: [{ key: "credits_100", name: "100 credits", description: "A pack of 100 credits", price: 10 }],
});

export function context(): WebhookContext {
  return { appTag: APP_TAG, itemForPriceId: (id) => itemForProviderRef("paddle", id, ENV, ITEMS) };
}

export function polarContext(): PolarContext {
  return { itemForProductId: (id) => itemForProviderRef("polar", id, POLAR_ENV, ITEMS) };
}

// ── Paddle payloads ──────────────────────────────────────────────────────────────────────────────────

export function subscriptionData(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_01test",
    status: "active",
    customer_id: CUSTOMER_ID,
    currency_code: "USD",
    custom_data: { app: APP_TAG, user_id: USER_ID },
    canceled_at: null,
    current_billing_period: { starts_at: "2026-10-14T00:00:00Z", ends_at: "2026-11-14T00:00:00Z" },
    billing_cycle: { interval: "month", frequency: 1 },
    scheduled_change: null,
    items: [{ quantity: 1, recurring: true, price: { id: "pri_pro_month", unit_price: { amount: "900", currency_code: "USD" }, billing_cycle: { interval: "month", frequency: 1 } } }],
    ...overrides,
  };
}

export function transactionData(overrides: Record<string, unknown> = {}) {
  return {
    id: "txn_01test",
    status: "completed",
    customer_id: CUSTOMER_ID,
    subscription_id: "sub_01test",
    origin: "api",
    currency_code: "USD",
    custom_data: { app: APP_TAG, user_id: USER_ID },
    invoice_number: "1001-10001",
    billed_at: "2026-10-14T00:00:05Z",
    items: [{ quantity: 1, price_id: "pri_pro_month", price: { id: "pri_pro_month" } }],
    details: { totals: { subtotal: "900", tax: "90", total: "990", grand_total: "990", currency_code: "USD" } },
    ...overrides,
  };
}

export function adjustmentData(overrides: Record<string, unknown> = {}) {
  return {
    id: "adj_01test",
    action: "refund",
    status: "approved",
    transaction_id: "txn_01test",
    customer_id: CUSTOMER_ID,
    currency_code: "USD",
    totals: { total: "990", currency_code: "USD" },
    ...overrides,
  };
}

let sequence = 0;
export function event(type: string, data: unknown, occurredAt = "2026-10-14T00:00:10Z", id?: string): PaddleEvent {
  sequence += 1;
  return { event_id: id ?? `evt_${String(sequence).padStart(6, "0")}`, event_type: type, occurred_at: occurredAt, data: data as JsonObject };
}

// ── Polar payloads (the field names and types of the real sandbox objects) ───────────────────────────

const polarCustomer = (userId: string | null = USER_ID) => ({ id: POLAR_CUSTOMER_ID, external_id: userId, email: "buyer@example.com" });

export function polarSubscriptionData(overrides: Record<string, unknown> = {}) {
  return {
    id: "6a1f0c52-0000-4000-8000-0000000000a1",
    created_at: "2026-10-14T00:00:00.000000Z",
    modified_at: "2026-10-14T00:00:03.000000Z",
    status: "active",
    amount: 900,
    currency: "usd",
    recurring_interval: "month",
    recurring_interval_count: 1,
    current_period_start: "2026-10-14T00:00:00.000000Z",
    current_period_end: "2026-11-14T00:00:00.000000Z",
    cancel_at_period_end: false,
    canceled_at: null,
    started_at: "2026-10-14T00:00:00.000000Z",
    ends_at: null,
    ended_at: null,
    customer_id: POLAR_CUSTOMER_ID,
    product_id: "prod_pro_month",
    seats: null,
    metadata: { user_id: USER_ID },
    customer: polarCustomer(),
    ...overrides,
  };
}

export function polarOrderData(overrides: Record<string, unknown> = {}) {
  return {
    id: "9d2e7a10-0000-4000-8000-0000000000b1",
    created_at: "2026-10-14T00:00:05.000000Z",
    modified_at: null,
    status: "paid",
    paid: true,
    subtotal_amount: 900,
    net_amount: 900,
    tax_amount: 90,
    total_amount: 990,
    refunded_amount: 0,
    refunded_tax_amount: 0,
    currency: "usd",
    billing_reason: "subscription_create",
    invoice_number: "TEST-0001",
    customer_id: POLAR_CUSTOMER_ID,
    product_id: "prod_pro_month",
    subscription_id: "6a1f0c52-0000-4000-8000-0000000000a1",
    metadata: { user_id: USER_ID },
    customer: polarCustomer(),
    ...overrides,
  };
}

export function polarEvent(type: string, data: unknown, occurredAt = "2026-10-14T00:00:10.000000Z", id?: string): PolarEvent {
  sequence += 1;
  return { event_id: id ?? `msg_${String(sequence).padStart(6, "0")}`, event_type: type, occurred_at: occurredAt, data };
}

export { polarCustomer };

// ── the in-memory store ──────────────────────────────────────────────────────────────────────────────

const key = (provider: Provider, id: string) => `${provider}_${id}`;

export class MemoryStore implements BillingStore {
  /** Paddle customers the server linked: `paddle_<customerId>` -> uid. Polar needs none (the uid is in the payload). */
  customers = new Map<string, string>([[key("paddle", CUSTOMER_ID), USER_ID]]);
  subscriptions = new Map<string, SubscriptionRow>();
  transactions = new Map<string, TransactionRow & { refunded: number }>();
  adjustments = new Map<string, AdjustmentRow>();
  events = new Map<string, { status: string; note: string | null }>();
  /** Set to make the next write fail, to test that a failure is recorded and retried. */
  failNextWrite = false;

  async claimEvent(e: WebhookEventRecord) {
    const id = key(e.provider, e.event_id);
    const seen = this.events.get(id);
    if (seen && seen.status !== "failed") return false;
    this.events.set(id, { status: "received", note: null });
    return true;
  }
  async finishEvent(provider: Provider, id: string, status: "processed" | "ignored", note: string) {
    this.events.set(key(provider, id), { status, note });
  }
  async failEvent(provider: Provider, id: string, message: string) {
    this.events.set(key(provider, id), { status: "failed", note: message });
  }
  async userIdForCustomer(provider: Provider, customerId: string) {
    return this.customers.get(key(provider, customerId)) ?? null;
  }
  private guard() {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("database is down");
    }
  }
  async upsertSubscription(row: SubscriptionRow) {
    this.guard();
    const stored = this.subscriptions.get(key(row.provider, row.id));
    // Instants, not strings: providers write timestamps with and without milliseconds.
    if (!stored || Date.parse(stored.event_occurred_at) <= Date.parse(row.event_occurred_at)) this.subscriptions.set(key(row.provider, row.id), row);
  }
  async upsertTransaction(row: TransactionRow) {
    this.guard();
    this.transactions.set(key(row.provider, row.id), { ...row, refunded: this.transactions.get(key(row.provider, row.id))?.refunded ?? 0 });
  }
  async getTransaction(provider: Provider, id: string) {
    const stored = this.transactions.get(key(provider, id));
    return stored ? { id: stored.id, user_id: stored.user_id } : null;
  }
  async upsertAdjustment(row: AdjustmentRow) {
    const stored = this.adjustments.get(key(row.provider, row.id));
    if (!stored || Date.parse(stored.event_occurred_at) <= Date.parse(row.event_occurred_at)) this.adjustments.set(key(row.provider, row.id), row);
  }
  async recomputeRefunded(provider: Provider, transactionId: string) {
    const refunded = [...this.adjustments.values()]
      .filter((a) => a.provider === provider && a.transaction_id === transactionId && a.status === "approved" && (a.action === "refund" || a.action === "chargeback"))
      .reduce((sum, a) => sum + a.total, 0);
    const stored = this.transactions.get(key(provider, transactionId));
    if (stored) stored.refunded = refunded;
  }
}
