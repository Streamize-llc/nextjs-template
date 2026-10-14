"use client";

import { useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import type { BillingInterval } from "@/config/billing";
import { billingErrorMessage } from "./messages";
import { getPaddle } from "./paddle-js";

type Target = { kind: "plan"; itemKey: string; interval: BillingInterval } | { kind: "product"; itemKey: string };

/**
 * Buys one thing: asks the server for a transaction (POST /api/billing/checkout), then opens Paddle's checkout on it. A visitor who is
 * not signed in is sent to `loginPath` and brought back here afterwards.
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
      const json = (await response.json().catch(() => ({}))) as { error?: string; transactionId?: string; clientToken?: string; environment?: "sandbox" | "production" };
      if (response.status === 401) {
        window.location.href = `${loginPath}?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      if (!response.ok || !json.transactionId || !json.clientToken || !json.environment) {
        setError(billingErrorMessage(json.error));
        return;
      }
      const paddle = await getPaddle(json.clientToken, json.environment);
      paddle.Checkout.open({
        transactionId: json.transactionId,
        settings: { displayMode: "overlay", successUrl: `${window.location.origin}${successPath}` },
      });
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
