"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { BillingInterval, BillingPlan } from "@/config/billing";
import { CheckoutButton } from "./checkout-button";
import { formatPrice } from "./format";

/**
 * The plan cards, with a month / year switch when any plan sells both. `currentPlanKey` marks the plan the user already has. When payments are
 * not configured yet (no price ids in `.env`) the buttons are replaced by a notice, so a fresh clone never shows a button that cannot work.
 */
export function PricingTable({
  plans,
  currency,
  loginPath,
  currentPlanKey,
  available,
}: {
  plans: readonly BillingPlan[];
  currency: string;
  loginPath: string;
  currentPlanKey: string | null;
  /** keys of the "plan:interval" combinations that have a price id in the environment */
  available: readonly string[];
}) {
  const hasYear = plans.some((plan) => plan.prices.year !== undefined);
  const hasMonth = plans.some((plan) => plan.prices.month !== undefined);
  const [interval, setInterval] = useState<BillingInterval>(hasMonth ? "month" : "year");
  const visible = plans.filter((plan) => plan.prices[interval] !== undefined);

  return (
    <div className="flex flex-col gap-8">
      {hasYear && hasMonth ? (
        <div role="group" aria-label="Billing period" className="mx-auto inline-flex rounded-md border p-1">
          {(["month", "year"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={interval === option}
              onClick={() => setInterval(option)}
              className={cn("rounded px-4 py-1.5 text-sm font-medium transition-colors", interval === option ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {option === "month" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {visible.map((plan) => {
          const amount = plan.prices[interval] as number;
          const isCurrent = currentPlanKey === plan.key;
          const canBuy = available.includes(`${plan.key}:${interval}`);
          return (
            <section key={plan.key} aria-labelledby={`plan-${plan.key}`} className={cn("flex flex-col gap-4 rounded-lg border p-6", plan.popular && "border-primary shadow-sm")}>
              <div>
                <h2 id={`plan-${plan.key}`} className="text-lg font-semibold">
                  {plan.name}
                  {plan.popular ? <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">Popular</span> : null}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
              </div>
              <p className="text-3xl font-bold">
                {formatPrice(amount, currency)}
                <span className="text-sm font-normal text-muted-foreground"> / {interval === "month" ? "month" : "year"}</span>
              </p>
              <ul className="flex flex-1 flex-col gap-2 text-sm">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <span aria-hidden="true">✓</span>
                    {feature}
                  </li>
                ))}
              </ul>
              {isCurrent ? (
                <p className="text-sm font-medium">Your current plan</p>
              ) : canBuy ? (
                <CheckoutButton target={{ kind: "plan", itemKey: plan.key, interval }} loginPath={loginPath} variant={plan.popular ? "default" : "outline"}>
                  Choose {plan.name}
                </CheckoutButton>
              ) : (
                <p className="text-sm text-muted-foreground">Not available yet.</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
