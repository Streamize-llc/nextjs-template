import { adapterFor } from "@/lib/billing/adapters";
import { linkedProviders, readCustomerLinks } from "@/lib/billing/customers";
import { getEntitlement } from "@/lib/billing/entitlements";
import { providerServerProblem } from "@/lib/billing/provider";
import { adapterUser, errorResponse, userOrResponse } from "@/lib/billing/route-helpers";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Best-effort brake (per server instance) so that a page that polls cannot hammer the providers' APIs.
const MIN_INTERVAL_MS = 2000;
const lastRun = new Map<string, number>();

/**
 * POST -> { entitlement }. Reads the signed-in user's subscriptions and payments from every provider they have been to (Paddle, Polar) and
 * applies them like the webhooks would, then answers what the user now has. The success page calls it until the plan shows up, so a slow or
 * lost webhook never leaves a paying user waiting. Safe next to the webhooks (see paddle/sync.ts and polar/sync.ts).
 */
export async function POST() {
  const auth = await userOrResponse();
  if ("response" in auth) return auth.response;
  const { supabase } = auth;
  const user = adapterUser(auth.user);

  const now = Date.now();
  if (now - (lastRun.get(user.id) ?? 0) < MIN_INTERVAL_MS) return errorResponse("too_many_requests", 429);
  lastRun.set(user.id, now);

  try {
    const providers = linkedProviders(await readCustomerLinks(supabase, user.id)).filter((provider) => {
      const problem = providerServerProblem(provider);
      if (problem) console.error(`[billing] cannot sync ${provider} for ${user.id}: ${problem}`);
      return problem === null;
    });
    if (providers.length > 0) {
      const admin = createAdminClient();
      if (!admin) return errorResponse("supabase_admin_not_configured", 503);
      const results = await Promise.allSettled(providers.map((provider) => adapterFor(provider).sync({ db: admin, user })));
      results.forEach((result, index) => {
        if (result.status === "rejected") console.error(`[${providers[index]}] sync failed:`, result.reason);
      });
      // Only when every provider we asked failed is it an error: the other one may well have answered.
      if (results.every((result) => result.status === "rejected")) return errorResponse("sync_failed", 502);
    }
    return Response.json({ entitlement: await getEntitlement(supabase, user.id) });
  } catch (error) {
    console.error("[billing] sync failed:", error);
    return errorResponse("sync_failed", 502);
  }
}
