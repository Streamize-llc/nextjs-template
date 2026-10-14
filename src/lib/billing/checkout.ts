/**
 * What a checkout request may ask for. The browser only NAMES the thing to buy (a plan and an interval, or a product); the provider's id,
 * the quantity and the customer are decided on the server. Pure: tests/billing-checkout.test.ts.
 */
import { catalogItems, type BillingInterval, type CatalogItem } from "@/config/billing";
import { providerRefFor } from "./catalog";
import type { Env, Provider } from "./types";

export type CheckoutError = "invalid_request" | "unknown_item" | "price_not_configured";

export interface CheckoutRequest {
  kind: "plan" | "product";
  key: string;
  interval: BillingInterval | null;
}

/** Parses the JSON body the browser sends. Anything unexpected is `invalid_request`. */
export function parseCheckoutRequest(body: unknown): CheckoutRequest | null {
  if (!body || typeof body !== "object") return null;
  const { kind, key, interval } = body as Record<string, unknown>;
  if ((kind !== "plan" && kind !== "product") || typeof key !== "string" || key.length === 0 || key.length > 40) return null;
  if (kind === "plan") {
    if (interval !== "month" && interval !== "year") return null;
    return { kind, key, interval };
  }
  return { kind, key, interval: null };
}

/** The catalog item the request names, and the PROVIDER's id of it (a Paddle price id, a Polar product id) from `.env`. */
export function resolveCheckoutItem(
  request: CheckoutRequest,
  provider: Provider,
  env: Env = process.env,
  items: CatalogItem[] = catalogItems(),
): { item: CatalogItem; ref: string } | { error: CheckoutError } {
  const item = items.find((candidate) => candidate.kind === request.kind && candidate.key === request.key && candidate.interval === request.interval);
  if (!item) return { error: "unknown_item" };
  const ref = providerRefFor(provider, item, env);
  if (!ref) return { error: "price_not_configured" };
  return { item, ref };
}
