/**
 * Which of OUR catalog items (src/config/billing.ts) a provider's id is, and the reverse. The ids live in `.env`
 * (`PADDLE_PRICE_*` for Paddle, `POLAR_PRODUCT_*` for Polar): only an id that is in the environment is ours, whatever else a payload says.
 * Pure (reads only the `env` it is given).
 */
import { billingConfig, catalogItems, providerEnvName, type BillingInterval, type CatalogItem } from "@/config/billing";
import type { Env, Provider } from "./types";

/** The provider's id of an item (a Paddle price id, a Polar product id) from `.env`, or null while it has not been created yet. */
export function providerRefFor(provider: Provider, item: { key: string; interval: BillingInterval | null }, env: Env = process.env): string | null {
  return env[providerEnvName(provider, item)]?.trim() || null;
}

/** The reverse: which of OUR items a provider's id is (null: not ours, or not configured). */
export function itemForProviderRef(provider: Provider, ref: string | undefined | null, env: Env = process.env, items: CatalogItem[] = catalogItems(billingConfig)): CatalogItem | null {
  if (!ref) return null;
  return items.find((item) => providerRefFor(provider, item, env) === ref) ?? null;
}

/** The items a provider can sell right now: the ones whose id is in the environment. */
export function sellableItems(provider: Provider, env: Env = process.env, items: CatalogItem[] = catalogItems(billingConfig)): CatalogItem[] {
  return items.filter((item) => providerRefFor(provider, item, env) !== null);
}
