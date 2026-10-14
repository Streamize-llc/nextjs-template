import { createPortalSession } from "@/lib/paddle/api";
import { errorResponse, paddleConfigOrResponse, userOrResponse } from "@/lib/paddle/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST -> { url, cancelUrl }: a short-lived, already-signed-in link to Paddle's customer portal, where the user updates the card, reads
 * invoices, changes plan or cancels. Make one per click; never store it. Reads the user's own rows through Row Level Security.
 */
export async function POST() {
  const configured = paddleConfigOrResponse();
  if ("response" in configured) return configured.response;

  const auth = await userOrResponse();
  if ("response" in auth) return auth.response;
  const { user, supabase } = auth;

  const customer = await supabase.from("billing_customers").select("paddle_customer_id").eq("user_id", user.id).limit(1);
  const customerId = customer.data?.[0]?.paddle_customer_id as string | undefined;
  if (!customerId) return errorResponse("no_customer", 404);

  try {
    const subscriptions = await supabase.from("billing_subscriptions").select("id").eq("user_id", user.id).in("status", ["active", "trialing", "past_due", "paused"]);
    const ids = (subscriptions.data ?? []).map((row) => row.id as string);
    const session = await createPortalSession(customerId, ids);
    return Response.json({ url: session.overview, cancelUrl: session.cancel });
  } catch (error) {
    console.error("[paddle] portal failed:", error);
    return errorResponse("portal_failed", 502);
  }
}
