/**
 * Links a signed-in user to a Paddle customer BEFORE a checkout is opened. That link (billing_customers) is what every later webhook is
 * credited through, so it is made only here, on the server, with the service role, from the e-mail of the authenticated session.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureCustomerId } from "./api";
import type { JsonObject } from "./types";

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
  const inserted = await db.from("billing_customers").insert({ user_id: user.id, paddle_customer_id: customerId });
  if (!inserted.error) return customerId;
  if (inserted.error.code !== UNIQUE_VIOLATION) throw new Error(`link billing customer: ${inserted.error.message}`);

  // Either this user was linked a moment ago by a second request (fine: use that one), or the customer belongs to somebody else.
  const again = await db.from("billing_customers").select("paddle_customer_id").eq("user_id", user.id).limit(1);
  const winner = again.data?.[0]?.paddle_customer_id as string | undefined;
  if (winner) return winner;
  throw new CustomerConflictError();
}
