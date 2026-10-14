import { createTransaction, PaddleApiError } from "@/lib/paddle/api";
import { parseCheckoutRequest, resolveCheckoutItem } from "@/lib/paddle/checkout";
import { paddleClientConfig } from "@/lib/paddle/config";
import { CustomerConflictError, ensureBillingCustomer } from "@/lib/paddle/customers";
import { entitlementFrom, type StoredSubscription } from "@/lib/paddle/entitlements";
import { errorResponse, paddleConfigOrResponse, userOrResponse } from "@/lib/paddle/route-helpers";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST { kind: "plan", key, interval } | { kind: "product", key }  ->  { transactionId, clientToken, environment }
 *
 * The browser names WHAT to buy. This route links the signed-in user to a Paddle customer, creates the transaction on Paddle's side (price,
 * quantity and customer are fixed here) and hands back its id; the browser opens it with `Paddle.Checkout.open({ transactionId })`.
 * Error answers are stable codes (the UI maps them to text): unauthorized, invalid_request, unknown_item, price_not_configured,
 * already_subscribed, email_required, email_not_verified, customer_conflict, paddle_not_configured, checkout_failed.
 */
export async function POST(request: Request) {
  const configured = paddleConfigOrResponse();
  if ("response" in configured) return configured.response;
  const { config } = configured;
  const client = paddleClientConfig();
  if (!client.token) {
    console.error("[paddle] NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set");
    return errorResponse("paddle_not_configured", 503);
  }

  const auth = await userOrResponse();
  if ("response" in auth) return auth.response;
  const { user } = auth;
  if (!user.email) return errorResponse("email_required", 400);
  // A Paddle customer is found BY E-MAIL and is shared by every app on the Paddle account. Linking one to a user whose address nobody has
  // confirmed would let anyone who signs up with a stranger's address open that stranger's customer portal (saved cards, invoices of other apps).
  if (!user.email_confirmed_at) return errorResponse("email_not_verified", 403);

  const parsed = parseCheckoutRequest(await request.json().catch(() => null));
  if (!parsed) return errorResponse("invalid_request", 400);
  const resolved = resolveCheckoutItem(parsed);
  if ("error" in resolved) return errorResponse(resolved.error, resolved.error === "unknown_item" ? 404 : 503);

  const admin = createAdminClient();
  if (!admin) {
    console.error("[paddle] SUPABASE_SERVICE_ROLE_KEY (or the Supabase URL) is not set");
    return errorResponse("supabase_admin_not_configured", 503);
  }

  try {
    // One subscription at a time: changing plan, cancelling and updating the card all go through the customer portal.
    if (resolved.item.kind === "plan") {
      const { data, error } = await admin
        .from("billing_subscriptions")
        .select("id, status, plan_key, billing_interval, current_period_end, cancel_at_period_end")
        .eq("user_id", user.id);
      if (error) throw new Error(`read subscriptions: ${error.message}`);
      const current = entitlementFrom((data ?? []) as StoredSubscription[]);
      if (current.active || current.pastDue || current.status === "paused") return errorResponse("already_subscribed", 409);
    }

    const customerId = await ensureBillingCustomer(admin, { id: user.id, email: user.email }, config.appTag);
    const transactionId = await createTransaction({
      priceId: resolved.priceId,
      customerId,
      customData: { app: config.appTag, user_id: user.id, item_key: resolved.item.key, interval: resolved.item.interval },
    });
    return Response.json({ transactionId, clientToken: client.token, environment: client.environment });
  } catch (error) {
    if (error instanceof CustomerConflictError) return errorResponse("customer_conflict", 409);
    console.error("[paddle] checkout failed:", error instanceof PaddleApiError ? error.message : error);
    return errorResponse("checkout_failed", 502);
  }
}
