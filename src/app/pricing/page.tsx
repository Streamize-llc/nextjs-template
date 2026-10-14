import type { Metadata } from "next";
import { PricingTable } from "@/components/billing/pricing-table";
import { billingConfig, catalogItems } from "@/config/billing";
import { paddleConfigured, priceIdFor } from "@/lib/paddle/config";
import { getEntitlement, NO_ENTITLEMENT } from "@/lib/paddle/entitlements";
import { createClient } from "@/utils/supabase/server";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Plans and pricing.",
};

// The signed-in user and the environment are read on every request.
export const dynamic = "force-dynamic";

/**
 * Public pricing page (Paddle's domain review reads it: keep the prices, what each plan includes and links to your Terms, Privacy and Refund
 * pages on it or in the footer, see PADDLE.md). Buttons only appear for plans whose price id is in `.env`.
 */
export default async function PricingPage() {
  const supabase = await createClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  const entitlement = supabase && user ? await getEntitlement(supabase, user.id).catch(() => NO_ENTITLEMENT) : NO_ENTITLEMENT;

  const ready = paddleConfigured();
  const available = ready
    ? catalogItems()
        .filter((item) => item.kind === "plan" && priceIdFor(item))
        .map((item) => `${item.key}:${item.interval}`)
    : [];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Pricing</h1>
        <p className="text-muted-foreground">Pick a plan. Cancel any time from your billing page.</p>
      </header>
      <PricingTable
        plans={billingConfig.plans}
        currency={billingConfig.currency}
        loginPath={billingConfig.loginPath}
        currentPlanKey={entitlement.active ? entitlement.planKey : null}
        available={available}
      />
      {!ready ? (
        <p className="text-center text-sm text-muted-foreground">
          Payments are not configured yet. Follow PADDLE.md: set the Paddle variables in <code>.env.local</code>, then run <code>npm run paddle:catalog</code>.
        </p>
      ) : null}
    </main>
  );
}
