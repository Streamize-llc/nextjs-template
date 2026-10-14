/**
 * Which payment provider takes NEW checkouts. `BILLING_PROVIDER=paddle|polar` says so; change it and redeploy to switch.
 *
 * Switching only changes where the NEXT purchase goes. Nothing that exists is touched: both webhooks keep being processed (as long as the
 * provider's secret is still in `.env`), `getEntitlement()` reads the subscriptions of both, a user who subscribed through the old provider
 * keeps their plan and their portal there, and a second subscription is refused while one is running (`already_subscribed`), so a switch can
 * never bill a customer twice. Pure: tests/billing-provider.test.ts.
 */
import { BILLING_PROVIDERS } from "@/config/billing";
import { paddleConfigProblem, paddleServerProblem } from "./paddle/config";
import { polarConfigProblem } from "./polar/config";
import type { Env, Provider } from "./types";

/** Why the provider cannot take a NEW checkout (a sentence for the server log), or null when it can. */
export function providerConfigProblem(provider: Provider, env: Env = process.env): string | null {
  return provider === "paddle" ? paddleConfigProblem(env) : polarConfigProblem(env);
}

/**
 * Why the server cannot talk to the provider for what already exists (a user's portal, a sync), or null. Looser than the above on purpose:
 * after a switch the old provider only has to keep serving its subscribers (no browser token, no price ids needed any more).
 */
export function providerServerProblem(provider: Provider, env: Env = process.env): string | null {
  return provider === "paddle" ? paddleServerProblem(env) : polarConfigProblem(env);
}

export type ProviderChoice = { provider: Provider } | { error: "billing_not_configured"; reason: string };

export function chooseBillingProvider(env: Env = process.env): ProviderChoice {
  const wanted = env.BILLING_PROVIDER?.trim().toLowerCase();
  if (wanted) {
    if (!(BILLING_PROVIDERS as readonly string[]).includes(wanted)) {
      return { error: "billing_not_configured", reason: `BILLING_PROVIDER must be "paddle" or "polar", not "${env.BILLING_PROVIDER}"` };
    }
    const problem = providerConfigProblem(wanted as Provider, env);
    return problem ? { error: "billing_not_configured", reason: `BILLING_PROVIDER is ${wanted} but ${problem}` } : { provider: wanted as Provider };
  }
  // Not set: fine as long as there is no doubt about which one is meant.
  const ready = BILLING_PROVIDERS.filter((provider) => providerConfigProblem(provider, env) === null);
  if (ready.length === 1) return { provider: ready[0] };
  if (ready.length === 0) return { error: "billing_not_configured", reason: "no payment provider is configured (set up Paddle or Polar, see BILLING.md)" };
  return { error: "billing_not_configured", reason: "both Paddle and Polar are configured: set BILLING_PROVIDER to the one that should take new checkouts" };
}
