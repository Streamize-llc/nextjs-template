/**
 * What a payment provider has to do for the template, so that the routes (/api/billing/checkout, portal, sync) are the same for Paddle and for
 * Polar. An adapter creates things at ITS provider and never decides who gets access: that is the webhooks' job (paddle/webhook.ts,
 * polar/webhook.ts), which write the same rows whichever provider sent them.
 *
 * To add a third provider: implement this, map its payloads to the rows of types.ts, add a webhook route and register it in adapters.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogItem } from "@/config/billing";
import type { Provider } from "./types";

export interface AdapterUser {
  id: string;
  email: string | null;
  emailVerified: boolean;
}

/** What the browser needs to start paying: Paddle opens an overlay on a transaction; Polar sends the buyer to its own checkout page. */
export type CheckoutOutcome =
  | { provider: "paddle"; transactionId: string; clientToken: string; environment: "sandbox" | "production" }
  | { provider: "polar"; url: string };

export interface ProviderAdapter {
  provider: Provider;
  /**
   * Paddle finds its customers BY E-MAIL and shares them between every app on the account, so a checkout needs an e-mail the user has
   * confirmed (otherwise an unverified sign-up with a stranger's address could open that stranger's portal). Polar's customer is the user id.
   */
  requiresVerifiedEmail: boolean;
  /** Creates the checkout at the provider. Everything that matters (item, quantity, customer) is decided here, never by the browser. `db` is the SERVICE-ROLE client. */
  createCheckout(input: { db: SupabaseClient; user: AdapterUser; item: CatalogItem; ref: string; origin: string }): Promise<CheckoutOutcome>;
  /** A fresh, signed-in link to the provider's customer portal; null when the provider has no customer for this user. `db` only reads (a user-session client is enough). */
  createPortal(input: { db: SupabaseClient; user: AdapterUser; subscriptionIds: readonly string[]; origin: string }): Promise<{ url: string; cancelUrl: string | null } | null>;
  /** Reads the user's subscriptions and payments from the provider and stores them (what the webhook would have). A no-op when the user has none there. `db` is the SERVICE-ROLE client. */
  sync(input: { db: SupabaseClient; user: AdapterUser }): Promise<void>;
}
