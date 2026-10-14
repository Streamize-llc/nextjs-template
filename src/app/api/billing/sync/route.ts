import { getEntitlement } from "@/lib/paddle/entitlements";
import { errorResponse, paddleConfigOrResponse, userOrResponse, webhookContext } from "@/lib/paddle/route-helpers";
import { supabaseBillingStore } from "@/lib/paddle/store";
import { syncCustomer } from "@/lib/paddle/sync";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Best-effort brake (per server instance) so that a page that polls cannot hammer the Paddle API.
const MIN_INTERVAL_MS = 2000;
const lastRun = new Map<string, number>();

/**
 * POST -> { entitlement }. Reads the signed-in user's subscriptions and payments from the Paddle API and applies them like the webhook
 * would, then answers what the user now has. The success page calls it until the plan shows up, so a slow or lost webhook never leaves a
 * paying user waiting. Safe next to the webhook (see src/lib/paddle/sync.ts).
 */
export async function POST() {
  const configured = paddleConfigOrResponse();
  if ("response" in configured) return configured.response;
  const { config } = configured;

  const auth = await userOrResponse();
  if ("response" in auth) return auth.response;
  const { user, supabase } = auth;

  const now = Date.now();
  if (now - (lastRun.get(user.id) ?? 0) < MIN_INTERVAL_MS) return errorResponse("too_many_requests", 429);
  lastRun.set(user.id, now);

  const customer = await supabase.from("billing_customers").select("paddle_customer_id").eq("user_id", user.id).limit(1);
  const customerId = customer.data?.[0]?.paddle_customer_id as string | undefined;
  if (!customerId) return Response.json({ entitlement: await getEntitlement(supabase, user.id) });

  const admin = createAdminClient();
  if (!admin) return errorResponse("supabase_admin_not_configured", 503);

  try {
    await syncCustomer(supabaseBillingStore(admin), customerId, user.id, webhookContext(config));
    return Response.json({ entitlement: await getEntitlement(supabase, user.id) });
  } catch (error) {
    console.error("[paddle] sync failed:", error);
    return errorResponse("sync_failed", 502);
  }
}
