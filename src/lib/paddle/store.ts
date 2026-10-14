/**
 * The Supabase implementation of `BillingStore` (webhook.ts). Pass it the SERVICE-ROLE client (`createAdminClient()`): every table it
 * writes has Row Level Security with no write policy, so only the service role can. Never pass it a client that carries a user's session.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingStore } from "./webhook";
import type { AdjustmentRow, SubscriptionRow, TransactionRow, WebhookEventRecord } from "./types";

/** A delivery stuck in `received` for this long is taken to have crashed mid-way and may be processed again. */
export const STALE_RECEIVED_MS = 5 * 60 * 1000;

const UNIQUE_VIOLATION = "23505";

function fail(what: string, error: { message: string } | null): asserts error is null {
  if (error) throw new Error(`${what}: ${error.message}`);
}

export function supabaseBillingStore(db: SupabaseClient, now: () => number = Date.now): BillingStore {
  return {
    async claimEvent(event: WebhookEventRecord) {
      const inserted = await db
        .from("billing_webhook_events")
        .insert({ event_id: event.event_id, event_type: event.event_type, occurred_at: event.occurred_at, payload: event.payload, status: "received" });
      if (!inserted.error) return true;
      if (inserted.error.code !== UNIQUE_VIOLATION) fail("claim webhook event", inserted.error);

      // Seen before. Take it over only if that attempt FAILED, or crashed and went stale (still `received` long after); a processed or
      // ignored one is a duplicate. Each takeover is ONE conditional update, so two deliveries racing for it cannot both win.
      const retake = { status: "received", received_at: new Date(now()).toISOString(), note: null };
      const afterFailure = await db.from("billing_webhook_events").update(retake).eq("event_id", event.event_id).eq("status", "failed").select("event_id");
      fail("retake failed webhook event", afterFailure.error);
      if ((afterFailure.data?.length ?? 0) > 0) return true;

      const stale = new Date(now() - STALE_RECEIVED_MS).toISOString();
      const afterCrash = await db
        .from("billing_webhook_events")
        .update(retake)
        .eq("event_id", event.event_id)
        .eq("status", "received")
        .lt("received_at", stale)
        .select("event_id");
      fail("retake stale webhook event", afterCrash.error);
      return (afterCrash.data?.length ?? 0) > 0;
    },

    async finishEvent(eventId, status, note) {
      const { error } = await db.from("billing_webhook_events").update({ status, note }).eq("event_id", eventId);
      fail("finish webhook event", error);
    },

    async failEvent(eventId, message) {
      const { error } = await db.from("billing_webhook_events").update({ status: "failed", note: message.slice(0, 500) }).eq("event_id", eventId);
      fail("fail webhook event", error);
    },

    async userIdForCustomer(customerId) {
      const { data, error } = await db.from("billing_customers").select("user_id").eq("paddle_customer_id", customerId).limit(1);
      fail("find customer", error);
      return (data?.[0]?.user_id as string | undefined) ?? null;
    },

    async upsertSubscription(row: SubscriptionRow) {
      // Two statements so that "only if not older" is decided by the database, atomically, not by a read in between:
      // insert when new (a conflict is left alone), then update only while the stored event is not newer than this one.
      const inserted = await db.from("billing_subscriptions").upsert(row, { onConflict: "id", ignoreDuplicates: true });
      fail("insert subscription", inserted.error);
      const { error } = await db.from("billing_subscriptions").update(row).eq("id", row.id).lte("event_occurred_at", row.event_occurred_at);
      fail("update subscription", error);
    },

    async upsertTransaction(row: TransactionRow) {
      // `refunded` is not in the row: an update must never reset what the adjustments have added up.
      const { error } = await db.from("billing_transactions").upsert(row, { onConflict: "id" });
      fail("upsert transaction", error);
    },

    async getTransaction(id) {
      const { data, error } = await db.from("billing_transactions").select("id, user_id").eq("id", id).limit(1);
      fail("find transaction", error);
      const row = data?.[0] as { id: string; user_id: string } | undefined;
      return row ?? null;
    },

    async upsertAdjustment(row: AdjustmentRow) {
      const { error } = await db.from("billing_adjustments").upsert(row, { onConflict: "id" });
      fail("upsert adjustment", error);
    },

    async recomputeRefunded(transactionId) {
      const { data, error } = await db.from("billing_adjustments").select("total, action, status").eq("transaction_id", transactionId);
      fail("read adjustments", error);
      const refunded = (data ?? [])
        .filter((a) => a.status === "approved" && (a.action === "refund" || a.action === "chargeback"))
        .reduce((sum, a) => sum + Number(a.total), 0);
      const updated = await db.from("billing_transactions").update({ refunded }).eq("id", transactionId);
      fail("update refunded", updated.error);
    },
  };
}
