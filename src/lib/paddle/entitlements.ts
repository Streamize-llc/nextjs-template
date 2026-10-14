/**
 * What a user has bought. This is the function the rest of YOUR app calls to decide what to show or allow:
 *
 *   const entitlement = await getEntitlement(supabase, user.id);   // a Supabase client with the user's session
 *   if (!entitlement.active) redirect("/pricing");
 *   if (entitlement.planKey === "team") { ... }
 *
 * It reads `billing_subscriptions` through Row Level Security, so a user can only ever read their own rows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Entitlement {
  /** Has a running subscription (active or in a trial). Paused, canceled and unpaid ones are not active. */
  active: boolean;
  /** The plan key (src/config/billing.ts) of the running subscription, or of the one that is past due. */
  planKey: string | null;
  interval: string | null;
  status: string | null;
  /** When the paid period ends (or the trial). */
  currentPeriodEnd: string | null;
  /** The user cancelled: it stays active until `currentPeriodEnd`, then ends. */
  cancelAtPeriodEnd: boolean;
  /** The last payment failed and Paddle is retrying. Not `active`: decide yourself whether to keep access during the retries. */
  pastDue: boolean;
  subscriptionId: string | null;
}

export const NO_ENTITLEMENT: Entitlement = {
  active: false,
  planKey: null,
  interval: null,
  status: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  pastDue: false,
  subscriptionId: null,
};

export interface StoredSubscription {
  id: string;
  status: string;
  plan_key: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

function toEntitlement(row: StoredSubscription): Entitlement {
  return {
    active: row.status === "active" || row.status === "trialing",
    planKey: row.plan_key,
    interval: row.billing_interval,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    pastDue: row.status === "past_due",
    subscriptionId: row.id,
  };
}

const RANK: Record<string, number> = { active: 3, trialing: 3, past_due: 2, paused: 1, canceled: 0 };

/** The single entitlement of a user with several subscription rows: a running one beats a past-due one beats the rest; newest period wins a tie. */
export function entitlementFrom(rows: readonly StoredSubscription[]): Entitlement {
  const best = [...rows].sort((a, b) => {
    const byStatus = (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0);
    if (byStatus !== 0) return byStatus;
    return String(b.current_period_end ?? "").localeCompare(String(a.current_period_end ?? ""));
  })[0];
  return best ? toEntitlement(best) : NO_ENTITLEMENT;
}

export async function getEntitlement(supabase: SupabaseClient, userId: string): Promise<Entitlement> {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("id, status, plan_key, billing_interval, current_period_end, cancel_at_period_end")
    .eq("user_id", userId);
  if (error) throw new Error(`read subscriptions: ${error.message}`);
  return entitlementFrom((data ?? []) as StoredSubscription[]);
}

/** Has this user paid for a one-time product (`billingConfig.products`) and not had it fully refunded? */
export async function hasPurchased(supabase: SupabaseClient, userId: string, productKey: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("billing_transactions")
    .select("total, refunded")
    .eq("user_id", userId)
    .eq("item_key", productKey)
    .eq("status", "completed");
  if (error) throw new Error(`read transactions: ${error.message}`);
  return (data ?? []).some((row) => Number(row.refunded) < Number(row.total));
}
