"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type State = "waiting" | "active" | "slow";

const EVERY_MS = 3000;
const GIVE_UP_AFTER_MS = 60_000;

/**
 * The page after a payment. The subscription row is written by Paddle's webhook, which can take a few seconds, so this asks the server
 * (POST /api/billing/sync, which also reads Paddle directly) every few seconds until the plan is active, and gives up politely after a minute.
 */
export function SuccessPoller() {
  const [state, setState] = useState<State>("waiting");

  useEffect(() => {
    let stopped = false;
    const started = Date.now();

    async function check() {
      try {
        const response = await fetch("/api/billing/sync", { method: "POST" });
        const json = (await response.json().catch(() => ({}))) as { entitlement?: { active?: boolean } };
        if (!stopped && json.entitlement?.active) {
          setState("active");
          return;
        }
      } catch {
        // try again below
      }
      if (stopped) return;
      if (Date.now() - started > GIVE_UP_AFTER_MS) setState("slow");
      else setTimeout(check, EVERY_MS);
    }

    void check();
    return () => {
      stopped = true;
    };
  }, []);

  if (state === "active") {
    return (
      <>
        <h1 className="text-3xl font-bold tracking-tight">You are all set</h1>
        <p className="text-muted-foreground">Your subscription is active. A receipt is on its way to your e-mail.</p>
        <Button asChild>
          <Link href="/billing">Go to billing</Link>
        </Button>
      </>
    );
  }
  if (state === "slow") {
    return (
      <>
        <h1 className="text-3xl font-bold tracking-tight">Thank you</h1>
        <p className="text-muted-foreground">Your payment went through, but it is taking longer than usual to show up here. Refresh this page in a minute; if it still does not, contact support.</p>
        <Button asChild variant="outline">
          <Link href="/billing">Go to billing</Link>
        </Button>
      </>
    );
  }
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">Thank you</h1>
      <p className="text-muted-foreground" role="status">
        Confirming your payment…
      </p>
    </>
  );
}
