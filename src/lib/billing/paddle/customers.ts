/**
 * Links a signed-in user to a Paddle customer BEFORE a checkout is opened. That link (billing_customers.paddle_customer_id, UNIQUE) is what
 * every later webhook is credited through, so it is made only here, on the server, with the service role, from the e-mail of the authenticated
 * session. The UNIQUE constraint is what makes it impossible for a Paddle customer to belong to two users.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JsonObject } from "../types";
import { ensureCustomerId } from "./api";

/** Another user is already linked to this Paddle customer (two accounts, one e-mail). Needs a human to look at it. */
export class CustomerConflictError extends Error {
  constructor() {
    super("this Paddle customer is already linked to another user");
    this.name = "CustomerConflictError";
  }
}

const UNIQUE_VIOLATION = "23505";

export async function ensureBillingCustomer(
  db: SupabaseClient,
  user: { id: string; email: string },
  appTag: string,
  createCustomerId: (email: string, customData: JsonObject) => Promise<string> = ensureCustomerId,
): Promise<string> {
  const stored = await db.from("billing_customers").select("paddle_customer_id").eq("user_id", user.id).limit(1);
  if (stored.error) throw new Error(`read billing customer: ${stored.error.message}`);
  const known = stored.data?.[0]?.paddle_customer_id as string | undefined;
  if (known) return known;

  const customerId = await createCustomerId(user.email, { app: appTag, user_id: user.id });

  // The user's row may exist already (a Polar link): create it only when missing, then set the Paddle customer only while it is still empty.
  const created = await db.from("billing_customers").upsert({ user_id: user.id }, { onConflict: "user_id", ignoreDuplicates: true });
  if (created.error) throw new Error(`link billing customer: ${created.error.message}`);
  const linked = await db.from("billing_customers").update({ paddle_customer_id: customerId }).eq("user_id", user.id).is("paddle_customer_id", null).select("paddle_customer_id");
  if (linked.error) {
    if (linked.error.code === UNIQUE_VIOLATION) throw new CustomerConflictError(); // the customer belongs to somebody else
    throw new Error(`link billing customer: ${linked.error.message}`);
  }
  if ((linked.data?.length ?? 0) > 0) return customerId;

  // Nothing was updated: a second request of this user linked first (fine: use that one).
  const again = await db.from("billing_customers").select("paddle_customer_id").eq("user_id", user.id).limit(1);
  const winner = again.data?.[0]?.paddle_customer_id as string | undefined;
  if (winner) return winner;
  throw new Error("could not link the Paddle customer");
}
