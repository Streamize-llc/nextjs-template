/**
 * What links a user to each payment provider: `billing_customers` (one row per user). The two providers differ on purpose:
 *
 *   Paddle  customers are found BY E-MAIL and shared by every app on the account, so the server records which customer is the user's
 *           (`paddle_customer_id`, UNIQUE: a Paddle customer can never belong to two users; paddle/customers.ts).
 *   Polar   the customer IS the user: the server sets `external_customer_id = user id` when it creates the checkout, and every Polar payload
 *           carries it back. Nothing to look up; only the moment of the first checkout is kept (`polar_linked_at`), so the sync knows to ask.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Provider } from "./types";

export interface CustomerLinks {
  paddleCustomerId: string | null;
  polarLinked: boolean;
}

export const NO_LINKS: CustomerLinks = { paddleCustomerId: null, polarLinked: false };

/** Reads the links of a user. With a user-session client, Row Level Security lets a user read only their own row. */
export async function readCustomerLinks(db: SupabaseClient, userId: string): Promise<CustomerLinks> {
  const { data, error } = await db.from("billing_customers").select("paddle_customer_id, polar_linked_at").eq("user_id", userId).limit(1);
  if (error) throw new Error(`read billing customer: ${error.message}`);
  const row = data?.[0] as { paddle_customer_id: string | null; polar_linked_at: string | null } | undefined;
  if (!row) return NO_LINKS;
  return { paddleCustomerId: row.paddle_customer_id || null, polarLinked: Boolean(row.polar_linked_at) };
}

/** The providers this user has been linked to (a checkout was opened with them). */
export function linkedProviders(links: CustomerLinks): Provider[] {
  const providers: Provider[] = [];
  if (links.paddleCustomerId) providers.push("paddle");
  if (links.polarLinked) providers.push("polar");
  return providers;
}

/** Remembers that this user opened a Polar checkout (idempotent: the first time wins). Needs the SERVICE-ROLE client. */
export async function markPolarLinked(admin: SupabaseClient, user: { id: string }, now: () => string = () => new Date().toISOString()): Promise<void> {
  // A row may exist already (a Paddle link): create it only when missing, then set the moment only while it is still empty.
  const created = await admin.from("billing_customers").upsert({ user_id: user.id }, { onConflict: "user_id", ignoreDuplicates: true });
  if (created.error) throw new Error(`link billing customer: ${created.error.message}`);
  const linked = await admin.from("billing_customers").update({ polar_linked_at: now() }).eq("user_id", user.id).is("polar_linked_at", null);
  if (linked.error) throw new Error(`link billing customer to Polar: ${linked.error.message}`);
}
