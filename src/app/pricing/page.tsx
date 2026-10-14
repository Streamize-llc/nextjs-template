import type { Metadata } from "next";
import { PricingTable } from "@/components/billing/pricing-table";
import { billingConfig } from "@/config/billing";
import { sellableItems } from "@/lib/billing/catalog";
import { getEntitlement, NO_ENTITLEMENT } from "@/lib/billing/entitlements";
import { chooseBillingProvider } from "@/lib/billing/provider";
import { createClient } from "@/utils/supabase/server";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Plans and pricing.",
};

// The signed-in user and the environment are read on every request.
export const dynamic = "force-dynamic";

/**
 * Public pricing page (a merchant of record's domain review reads it: keep the prices, what each plan includes and links to your Terms,
 * Privacy and Refund pages on it or in the footer, see BILLING.md). Buttons only appear for plans the provider that takes new checkouts can
 * sell (its ids are in `.env`), so a fresh clone never shows a button that cannot work.
 */
export default async function PricingPage() {
  const supabase = await createClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  const entitlement = supabase && user ? await getEntitlement(supabase, user.id).catch(() => NO_ENTITLEMENT) : NO_ENTITLEMENT;

  const choice = chooseBillingProvider();
  const ready = "provider" in choice;
  const available = ready
    ? sellableItems(choice.provider)
        .filter((item) => item.kind === "plan")
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
          Payments are not configured yet. Follow BILLING.md: set up Paddle or Polar in <code>.env.local</code>, then run its catalog script (<code>npm run paddle:catalog</code> or <code>npm run polar:catalog</code>).
        </p>
      ) : null}
    </main>
  );
}
