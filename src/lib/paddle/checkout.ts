/**
 * What a checkout request may ask for. The browser only NAMES the thing to buy (a plan and an interval, or a product); the price id, the
 * quantity and the customer are decided on the server. Pure: tests/paddle-checkout.test.ts.
 */
import { catalogItems, type BillingInterval, type CatalogItem } from "@/config/billing";
import { priceIdFor, type Env } from "./config";

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

export function resolveCheckoutItem(
  request: CheckoutRequest,
  env: Env = process.env,
  items: CatalogItem[] = catalogItems(),
): { item: CatalogItem; priceId: string } | { error: CheckoutError } {
  const item = items.find((candidate) => candidate.kind === request.kind && candidate.key === request.key && candidate.interval === request.interval);
  if (!item) return { error: "unknown_item" };
  const priceId = priceIdFor(item, env);
  if (!priceId) return { error: "price_not_configured" };
  return { item, priceId };
}
