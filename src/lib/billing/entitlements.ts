/**
 * What a user has bought. This is the function the rest of YOUR app calls to decide what to show or allow:
 *
 *   const entitlement = await getEntitlement(supabase, user.id);   // a Supabase client with the user's session
 *   if (!entitlement.active) redirect("/pricing");
 *   if (entitlement.planKey === "team") { ... }
 *
 * It does not care WHICH provider (Paddle or Polar) bills the user, so switching `BILLING_PROVIDER` never touches the code that gates your
 * features: a user who subscribed through Paddle keeps their access while new customers go through Polar, and the other way round.
 *
 * It reads `billing_subscriptions` through Row Level Security, so a user can only ever read their own rows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { linkedProviders, type CustomerLinks } from "./customers";
import type { Provider } from "./types";

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
  /** The last payment failed and the provider is retrying. Not `active`: decide yourself whether to keep access during the retries. */
  pastDue: boolean;
  /** The provider's id of the subscription. */
  subscriptionId: string | null;
  /** Who bills it: "paddle" or "polar". */
  provider: Provider | null;
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
  provider: null,
};

export interface StoredSubscription {
  id: string;
  provider: Provider;
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
    provider: row.provider,
  };
}

const RANK: Record<string, number> = { active: 3, trialing: 3, past_due: 2, paused: 1, canceled: 0 };

/** Newest period first within a status: compared as instants (providers write timestamps with and without milliseconds, and Postgres its own way). */
const periodEnd = (row: StoredSubscription): number => {
  const instant = Date.parse(String(row.current_period_end ?? ""));
  return Number.isNaN(instant) ? 0 : instant;
};

/** The one subscription that speaks for a user with several rows: a running one beats a past-due one beats the rest; newest period wins a tie. */
export function bestSubscription(rows: readonly StoredSubscription[]): StoredSubscription | null {
  return (
    [...rows].sort((a, b) => {
      const byStatus = (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0);
      return byStatus !== 0 ? byStatus : periodEnd(b) - periodEnd(a);
    })[0] ?? null
  );
}

export function entitlementFrom(rows: readonly StoredSubscription[]): Entitlement {
  const best = bestSubscription(rows);
  return best ? toEntitlement(best) : NO_ENTITLEMENT;
}

/**
 * Which provider's portal and sync a user belongs to: the provider of their best subscription (a canceled one still points at the place
 * where its invoices are), else of their latest payment, else a provider they started a checkout with (`preferred`, the one that is used
 * for new checkouts, first). null: they never started one.
 */
export function providerForUser(input: {
  subscriptions: readonly StoredSubscription[];
  lastPaymentProvider: Provider | null;
  links: CustomerLinks;
  preferred?: Provider | null;
}): Provider | null {
  const best = bestSubscription(input.subscriptions);
  if (best) return best.provider;
  if (input.lastPaymentProvider) return input.lastPaymentProvider;
  const linked = linkedProviders(input.links);
  if (input.preferred && linked.includes(input.preferred)) return input.preferred;
  return linked[0] ?? null;
}

/** All the subscription rows of a user, of every provider. */
export async function readSubscriptions(supabase: SupabaseClient, userId: string): Promise<StoredSubscription[]> {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("id, provider, status, plan_key, billing_interval, current_period_end, cancel_at_period_end")
    .eq("user_id", userId);
  if (error) throw new Error(`read subscriptions: ${error.message}`);
  return (data ?? []) as StoredSubscription[];
}

/** The provider of the user's most recent payment. */
export async function readLastPaymentProvider(supabase: SupabaseClient, userId: string): Promise<Provider | null> {
  const { data, error } = await supabase.from("billing_transactions").select("provider").eq("user_id", userId).order("billed_at", { ascending: false, nullsFirst: false }).limit(1);
  if (error) throw new Error(`read transactions: ${error.message}`);
  const provider = data?.[0]?.provider;
  return provider === "paddle" || provider === "polar" ? provider : null;
}

export async function getEntitlement(supabase: SupabaseClient, userId: string): Promise<Entitlement> {
  return entitlementFrom(await readSubscriptions(supabase, userId));
}

/** Has this user paid for a one-time product (`billingConfig.products`) and not had it fully refunded? Whichever provider took the payment. */
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
