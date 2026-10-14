import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ManageButton } from "@/components/billing/manage-button";
import { formatDate, formatMinor } from "@/components/billing/format";
import { billingConfig } from "@/config/billing";
import { getEntitlement } from "@/lib/paddle/entitlements";
import { createClient } from "@/utils/supabase/server";

export const metadata: Metadata = {
  title: "Billing",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

const STATUS_TEXT: Record<string, string> = {
  active: "Active",
  trialing: "In trial",
  past_due: "Payment failed: Paddle is retrying",
  paused: "Paused",
  canceled: "Canceled",
};

/** The signed-in user's subscription and payments, and the button into Paddle's portal. All reads go through Row Level Security. */
export default async function BillingPage() {
  const supabase = await createClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  if (!supabase || !user) redirect(`${billingConfig.loginPath}?next=/billing`);

  const entitlement = await getEntitlement(supabase, user.id);
  const plan = billingConfig.plans.find((candidate) => candidate.key === entitlement.planKey);
  const { data: transactions } = await supabase
    .from("billing_transactions")
    .select("id, billed_at, total, refunded, currency, status, invoice_number")
    .order("billed_at", { ascending: false })
    .limit(10);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight">Billing</h1>

      <section aria-labelledby="subscription" className="flex flex-col gap-4 rounded-lg border p-6">
        <h2 id="subscription" className="text-lg font-semibold">
          Subscription
        </h2>
        {entitlement.status ? (
          <>
            <p>
              <strong>{plan?.name ?? entitlement.planKey ?? "Unknown plan"}</strong>
              {entitlement.interval ? ` · billed every ${entitlement.interval}` : null}
            </p>
            <p className="text-sm text-muted-foreground">
              {STATUS_TEXT[entitlement.status] ?? entitlement.status}
              {entitlement.currentPeriodEnd
                ? entitlement.cancelAtPeriodEnd
                  ? `. Ends on ${formatDate(entitlement.currentPeriodEnd)}.`
                  : `. Renews on ${formatDate(entitlement.currentPeriodEnd)}.`
                : null}
            </p>
            <ManageButton />
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">You do not have a subscription.</p>
            <Link href="/pricing" className="text-sm font-medium underline underline-offset-4">
              See plans
            </Link>
          </>
        )}
      </section>

      <section aria-labelledby="payments" className="flex flex-col gap-4 rounded-lg border p-6">
        <h2 id="payments" className="text-lg font-semibold">
          Payments
        </h2>
        {transactions && transactions.length > 0 ? (
          <ul className="divide-y text-sm">
            {transactions.map((transaction) => (
              <li key={transaction.id as string} className="flex items-center justify-between gap-4 py-3">
                <span>
                  {formatDate(transaction.billed_at as string | null)}
                  {transaction.invoice_number ? <span className="text-muted-foreground"> · #{transaction.invoice_number as string}</span> : null}
                </span>
                <span>
                  {formatMinor(Number(transaction.total), transaction.currency as string)}
                  {Number(transaction.refunded) > 0 ? <span className="text-muted-foreground"> (refunded {formatMinor(Number(transaction.refunded), transaction.currency as string)})</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No payments yet.</p>
        )}
        <p className="text-xs text-muted-foreground">Receipts and invoices are in the portal (“Manage billing”).</p>
      </section>
    </main>
  );
}
