// Shared by the Paddle tests: payload builders shaped like Paddle's real webhooks, and an in-memory BillingStore that follows the same
// rules as the Supabase one (a duplicate is not processed twice, an older subscription event never overwrites a newer one).
import { billingConfig, catalogItems } from "@/config/billing";
import { itemForPriceId } from "@/lib/paddle/config";
import type { BillingStore, WebhookContext } from "@/lib/paddle/webhook";
import type { AdjustmentRow, JsonObject, PaddleEvent, SubscriptionRow, TransactionRow, WebhookEventRecord } from "@/lib/paddle/types";

export const APP_TAG = "test-app";
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const CUSTOMER_ID = "ctm_01testcustomer";

/** The price ids "in .env": the plans of src/config/billing.ts plus one one-time product. */
export const ENV = {
  PADDLE_PRICE_PRO_MONTH: "pri_pro_month",
  PADDLE_PRICE_PRO_YEAR: "pri_pro_year",
  PADDLE_PRICE_TEAM_MONTH: "pri_team_month",
  PADDLE_PRICE_TEAM_YEAR: "pri_team_year",
  PADDLE_PRICE_CREDITS_100: "pri_credits_100",
};

export const ITEMS = catalogItems({
  plans: billingConfig.plans,
  products: [{ key: "credits_100", name: "100 credits", description: "A pack of 100 credits", price: 10 }],
});

export function context(): WebhookContext {
  return { appTag: APP_TAG, itemForPriceId: (id) => itemForPriceId(id, ENV, ITEMS) };
}

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

export class MemoryStore implements BillingStore {
  customers = new Map<string, string>([[CUSTOMER_ID, USER_ID]]);
  subscriptions = new Map<string, SubscriptionRow>();
  transactions = new Map<string, TransactionRow & { refunded: number }>();
  adjustments = new Map<string, AdjustmentRow>();
  events = new Map<string, { status: string; note: string | null }>();
  /** Set to make the next write fail, to test that a failure is recorded and retried. */
  failNextWrite = false;

  async claimEvent(e: WebhookEventRecord) {
    const seen = this.events.get(e.event_id);
    if (seen && seen.status !== "failed") return false;
    this.events.set(e.event_id, { status: "received", note: null });
    return true;
  }
  async finishEvent(id: string, status: "processed" | "ignored", note: string) {
    this.events.set(id, { status, note });
  }
  async failEvent(id: string, message: string) {
    this.events.set(id, { status: "failed", note: message });
  }
  async userIdForCustomer(customerId: string) {
    return this.customers.get(customerId) ?? null;
  }
  private guard() {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("database is down");
    }
  }
  async upsertSubscription(row: SubscriptionRow) {
    this.guard();
    const stored = this.subscriptions.get(row.id);
    if (!stored || stored.event_occurred_at <= row.event_occurred_at) this.subscriptions.set(row.id, row);
  }
  async upsertTransaction(row: TransactionRow) {
    this.guard();
    this.transactions.set(row.id, { ...row, refunded: this.transactions.get(row.id)?.refunded ?? 0 });
  }
  async getTransaction(id: string) {
    const stored = this.transactions.get(id);
    return stored ? { id: stored.id, user_id: stored.user_id } : null;
  }
  async upsertAdjustment(row: AdjustmentRow) {
    this.adjustments.set(row.id, row);
  }
  async recomputeRefunded(transactionId: string) {
    const refunded = [...this.adjustments.values()]
      .filter((a) => a.transaction_id === transactionId && a.status === "approved" && (a.action === "refund" || a.action === "chargeback"))
      .reduce((sum, a) => sum + a.total, 0);
    const stored = this.transactions.get(transactionId);
    if (stored) stored.refunded = refunded;
  }
}
