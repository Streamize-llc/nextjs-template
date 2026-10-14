"use client";

import { useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import type { BillingInterval } from "@/config/billing";
import { nextCheckoutStep, type CheckoutAnswer } from "./checkout-flow";
import { billingErrorMessage } from "./messages";
import { getPaddle } from "./paddle-js";

type Target = { kind: "plan"; itemKey: string; interval: BillingInterval } | { kind: "product"; itemKey: string };

/**
 * Buys one thing: asks the server to create the checkout (POST /api/billing/checkout), then continues the way the provider that takes new
 * checkouts wants: Paddle's overlay opens on the transaction, Polar's checkout page replaces this one. The button does not need to know
 * which one is configured. A visitor who is not signed in is sent to `loginPath` and brought back here afterwards.
 */
export function CheckoutButton({
  target,
  loginPath,
  successPath = "/billing/success",
  children,
  ...buttonProps
}: { target: Target; loginPath: string; successPath?: string } & Omit<ButtonProps, "onClick" | "disabled" | "target">) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target.kind === "plan" ? { kind: "plan", key: target.itemKey, interval: target.interval } : { kind: "product", key: target.itemKey }),
      });
      const step = nextCheckoutStep(response.status, response.ok, (await response.json().catch(() => ({}))) as CheckoutAnswer);
      if (step.action === "sign_in") {
        window.location.href = `${loginPath}?next=${encodeURIComponent(window.location.pathname)}`;
      } else if (step.action === "redirect") {
        window.location.href = step.url;
      } else if (step.action === "paddle_overlay") {
        const paddle = await getPaddle(step.clientToken, step.environment);
        paddle.Checkout.open({
          transactionId: step.transactionId,
          settings: { displayMode: "overlay", successUrl: `${window.location.origin}${successPath}` },
        });
      } else {
        setError(billingErrorMessage(step.code));
      }
    } catch (caught) {
      setError(billingErrorMessage(caught instanceof Error ? caught.message : null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button {...buttonProps} onClick={buy} disabled={busy}>
        {busy ? "Opening…" : children}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
