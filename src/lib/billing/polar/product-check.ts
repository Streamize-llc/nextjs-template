/**
 * Does a Polar product match what src/config/billing.ts says it should be? A merchant of record reviews that the price on your site is the price
 * Polar charges, and a product created by hand in the dashboard is easy to get wrong (monthly instead of yearly, $9 instead of $9.00 in the wrong
 * currency). `npm run polar:check` runs this against the real products. Pure, and no imports: scripts/polar-setup.mjs loads this file directly.
 */
export interface PolarProductLike {
  id?: string;
  is_archived?: boolean;
  /** month | year for a subscription product, null for a one-time one. */
  recurring_interval?: string | null;
  prices?: { is_archived?: boolean; amount_type?: string; price_amount?: number; price_currency?: string }[];
}

export interface ExpectedProduct {
  /** null: a one-time product. */
  interval: "month" | "year" | null;
  /** Minor units (cents) of `currency`. */
  amountMinor: number;
  /** ISO 4217, any case. */
  currency: string;
}

/** What is wrong with the product, in words for the person fixing it. An empty list: it matches. */
export function productProblems(product: PolarProductLike, expected: ExpectedProduct): string[] {
  const problems: string[] = [];
  if (product.is_archived) problems.push("it is archived (an archived product cannot be bought)");
  const interval = product.recurring_interval ?? null;
  if (interval !== expected.interval) {
    problems.push(`it bills ${interval ? `every ${interval}` : "once"}, but the catalog wants ${expected.interval ? `every ${expected.interval}` : "a one-time payment"}`);
  }
  const live = (product.prices ?? []).filter((price) => !price.is_archived);
  if (live.length === 0) problems.push("it has no active price");
  else if (live.length > 1) problems.push(`it has ${live.length} active prices: keep one, the checkout cannot choose`);
  else {
    const [price] = live;
    if (price.amount_type !== "fixed") problems.push(`its price is "${price.amount_type}", not a fixed amount`);
    else {
      if (price.price_amount !== expected.amountMinor) problems.push(`its price is ${price.price_amount} (minor units), the catalog says ${expected.amountMinor}`);
      if ((price.price_currency ?? "").toLowerCase() !== expected.currency.toLowerCase()) problems.push(`its currency is ${price.price_currency}, the catalog says ${expected.currency}`);
    }
  }
  return problems;
}
