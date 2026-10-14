"use client";

import { useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { billingErrorMessage } from "./messages";

/** Opens Paddle's customer portal (card, invoices, plan, cancellation) with a fresh signed-in link. */
export function ManageButton({ children = "Manage billing", ...buttonProps }: Omit<ButtonProps, "onClick" | "disabled">) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/billing/portal", { method: "POST" });
      const json = (await response.json().catch(() => ({}))) as { error?: string; url?: string };
      if (!response.ok || !json.url) {
        setError(billingErrorMessage(json.error));
        return;
      }
      window.location.href = json.url;
    } catch {
      setError(billingErrorMessage(null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" {...buttonProps} onClick={open} disabled={busy}>
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
