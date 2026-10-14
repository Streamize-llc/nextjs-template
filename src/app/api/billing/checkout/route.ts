import { adapterFor } from "@/lib/billing/adapters";
import { parseCheckoutRequest, resolveCheckoutItem } from "@/lib/billing/checkout";
import { entitlementFrom, readSubscriptions } from "@/lib/billing/entitlements";
import { CustomerConflictError } from "@/lib/billing/paddle/customers";
import { chooseBillingProvider } from "@/lib/billing/provider";
import { adapterUser, errorResponse, userOrResponse } from "@/lib/billing/route-helpers";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST { kind: "plan", key, interval } | { kind: "product", key }
 *   ->  Paddle: { provider: "paddle", transactionId, clientToken, environment }  (the browser opens Paddle's overlay on the transaction)
 *   ->  Polar:  { provider: "polar", url }                                       (the browser goes to Polar's checkout page)
 *
 * The browser names WHAT to buy. This route picks the provider that takes new checkouts (`BILLING_PROVIDER`), links the signed-in user to
 * that provider's customer and creates the checkout on the provider's side (item, quantity and customer are fixed here).
 * Error answers are stable codes (the UI maps them to text): unauthorized, invalid_request, unknown_item, price_not_configured,
 * already_subscribed, email_required, email_not_verified, customer_conflict, billing_not_configured, supabase_admin_not_configured, checkout_failed.
 */
export async function POST(request: Request) {
  const choice = chooseBillingProvider();
  if ("error" in choice) {
    console.error(`[billing] ${choice.reason}`);
    return errorResponse(choice.error, 503);
  }
  const adapter = adapterFor(choice.provider);

  const auth = await userOrResponse();
  if ("response" in auth) return auth.response;
  const user = adapterUser(auth.user);
  if (adapter.requiresVerifiedEmail) {
    if (!user.email) return errorResponse("email_required", 400);
    // See ProviderAdapter.requiresVerifiedEmail: Paddle customers are found by e-mail and shared across apps.
    if (!user.emailVerified) return errorResponse("email_not_verified", 403);
  }

  const parsed = parseCheckoutRequest(await request.json().catch(() => null));
  if (!parsed) return errorResponse("invalid_request", 400);
  const resolved = resolveCheckoutItem(parsed, choice.provider);
  if ("error" in resolved) return errorResponse(resolved.error, resolved.error === "unknown_item" ? 404 : 503);

  const admin = createAdminClient();
  if (!admin) {
    console.error("[billing] SUPABASE_SERVICE_ROLE_KEY (or the Supabase URL) is not set");
    return errorResponse("supabase_admin_not_configured", 503);
  }

  try {
    // One subscription at a time, whichever provider bills it: changing plan, cancelling and updating the card all go through the provider's
    // customer portal. This is also what makes switching BILLING_PROVIDER safe: a subscriber of the old provider cannot start a second one.
    if (resolved.item.kind === "plan") {
      const current = entitlementFrom(await readSubscriptions(admin, user.id));
      if (current.active || current.pastDue || current.status === "paused") return errorResponse("already_subscribed", 409);
    }

    const outcome = await adapter.createCheckout({ db: admin, user, item: resolved.item, ref: resolved.ref, origin: new URL(request.url).origin });
    return Response.json(outcome);
  } catch (error) {
    if (error instanceof CustomerConflictError) return errorResponse("customer_conflict", 409);
    console.error(`[${choice.provider}] checkout failed:`, error instanceof Error ? error.message : error);
    return errorResponse("checkout_failed", 502);
  }
}
