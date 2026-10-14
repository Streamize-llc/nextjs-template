import { adapterFor } from "@/lib/billing/adapters";
import { readCustomerLinks } from "@/lib/billing/customers";
import { providerForUser, readLastPaymentProvider, readSubscriptions } from "@/lib/billing/entitlements";
import { chooseBillingProvider, providerServerProblem } from "@/lib/billing/provider";
import { adapterUser, errorResponse, userOrResponse } from "@/lib/billing/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUNNING = ["active", "trialing", "past_due", "paused"];

/**
 * POST -> { url, cancelUrl }: a short-lived, already-signed-in link to the customer portal of the provider that BILLS this user (Paddle or
 * Polar, whatever `BILLING_PROVIDER` says now: after a switch an existing subscriber still manages their subscription where it lives). The
 * user updates the card, reads invoices, changes plan or cancels there. Make one per click; never store it. Reads the user's own rows
 * through Row Level Security (no service role needed).
 */
export async function POST(request: Request) {
  const auth = await userOrResponse();
  if ("response" in auth) return auth.response;
  const { supabase } = auth;
  const user = adapterUser(auth.user);

  try {
    const [subscriptions, lastPaymentProvider, links] = await Promise.all([readSubscriptions(supabase, user.id), readLastPaymentProvider(supabase, user.id), readCustomerLinks(supabase, user.id)]);
    const current = chooseBillingProvider();
    const provider = providerForUser({ subscriptions, lastPaymentProvider, links, preferred: "provider" in current ? current.provider : null });
    if (!provider) return errorResponse("no_customer", 404);

    const problem = providerServerProblem(provider);
    if (problem) {
      console.error(`[billing] this user is billed by ${provider} but ${problem}: their portal cannot open`);
      return errorResponse("billing_not_configured", 503);
    }

    const ids = subscriptions.filter((row) => row.provider === provider && RUNNING.includes(row.status)).map((row) => row.id);
    const session = await adapterFor(provider).createPortal({ db: supabase, user, subscriptionIds: ids, origin: new URL(request.url).origin });
    if (!session) return errorResponse("no_customer", 404);
    return Response.json({ provider, url: session.url, cancelUrl: session.cancelUrl });
  } catch (error) {
    console.error("[billing] portal failed:", error);
    return errorResponse("portal_failed", 502);
  }
}
