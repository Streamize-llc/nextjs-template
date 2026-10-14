/**
 * What this app sells. EDIT THIS FILE FIRST after cloning the template: it is the one place the pricing page, the checkout,
 * the webhook and `npm run paddle:catalog` (which creates the products and prices in Paddle from it) all read.
 *
 * Nothing secret lives here (it ships to the browser). Price IDs live in the environment, never here: after
 * `npm run paddle:catalog` the script prints one `PADDLE_PRICE_<KEY>_<INTERVAL>` line per price to put into `.env.local`.
 * See PADDLE.md.
 */

export type BillingInterval = "month" | "year";

export interface BillingPlan {
  /** Lowercase letters, digits and underscores. Stored in the database and part of the env var name `PADDLE_PRICE_<KEY>_<INTERVAL>`. */
  key: string;
  name: string;
  description: string;
  features: readonly string[];
  /** Price per interval in MAJOR units of `billingConfig.currency` (9 = $9.00). Leave an interval out to not sell it. */
  prices: Partial<Record<BillingInterval, number>>;
  /** Highlight this plan on the pricing page. */
  popular?: boolean;
}

export interface BillingProduct {
  /** Same rules as a plan key. */
  key: string;
  name: string;
  description: string;
  /** One-time price in major units. */
  price: number;
}

export const billingConfig = {
  /** ISO 4217. Paddle prices are created in this currency; Paddle shows buyers their local currency at checkout where it can. */
  currency: "USD",

  /** Where a visitor who is not signed in is sent to sign in (the template has no login page: add yours). `?next=<path>` is appended. */
  loginPath: "/login",

  /**
   * Subscription plans (recurring). Replace these two examples. A user with an active plan is found with `getEntitlement()`
   * (src/lib/paddle/entitlements.ts); what a plan allows is YOUR code, keyed on `plan.key`.
   */
  plans: [
    {
      key: "pro",
      name: "Pro",
      description: "For individuals who use the app every day.",
      features: ["Everything in Free", "Unlimited projects", "Email support"],
      prices: { month: 9, year: 90 },
      popular: true,
    },
    {
      key: "team",
      name: "Team",
      description: "For small teams that work together.",
      features: ["Everything in Pro", "Up to 10 members", "Priority support"],
      prices: { month: 29, year: 290 },
    },
  ],

  /**
   * One-time purchases (a credit pack, a lifetime licence). Empty by default. Each one is bought once per checkout; a completed
   * payment is recorded in `billing_transactions` with `item_key = <key>` and you grant whatever it unlocks.
   */
  products: [] as readonly BillingProduct[],
} as const satisfies {
  currency: string;
  loginPath: string;
  plans: readonly BillingPlan[];
  products: readonly BillingProduct[];
};

export type PlanKey = (typeof billingConfig.plans)[number]["key"];

/** Every sellable thing, in one list: what the checkout route and the catalog script iterate. */
export type CatalogItem =
  | { kind: "plan"; key: string; interval: BillingInterval; name: string; description: string; amount: number }
  | { kind: "product"; key: string; interval: null; name: string; description: string; amount: number };

export function catalogItems(config: { plans: readonly BillingPlan[]; products: readonly BillingProduct[] } = billingConfig): CatalogItem[] {
  const items: CatalogItem[] = [];
  for (const plan of config.plans) {
    for (const interval of ["month", "year"] as const) {
      const amount = plan.prices[interval];
      if (amount !== undefined) items.push({ kind: "plan", key: plan.key, interval, name: plan.name, description: plan.description, amount });
    }
  }
  for (const product of config.products) {
    items.push({ kind: "product", key: product.key, interval: null, name: product.name, description: product.description, amount: product.price });
  }
  return items;
}

/** `PADDLE_PRICE_PRO_MONTH`, `PADDLE_PRICE_CREDITS_100` ... the env var that holds the Paddle price id of an item. */
export function priceEnvName(item: { key: string; interval: BillingInterval | null }): string {
  return `PADDLE_PRICE_${item.key.toUpperCase()}${item.interval ? `_${item.interval.toUpperCase()}` : ""}`;
}

const KEY = /^[a-z][a-z0-9_]{0,30}$/;

function hasSubCentPrecision(amount: number): boolean {
  return Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6;
}

/** Mistakes in this file that would only show up as a broken checkout in production. Run by the tests. */
export function validateBillingConfig(config: { currency: string; plans: readonly BillingPlan[]; products: readonly BillingProduct[] } = billingConfig): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const entry of [...config.plans, ...config.products]) {
    if (!KEY.test(entry.key)) problems.push(`key "${entry.key}" must be lowercase letters, digits and underscores, starting with a letter`);
    if (keys.has(entry.key)) problems.push(`key "${entry.key}" is used twice`);
    keys.add(entry.key);
  }
  for (const plan of config.plans) {
    const intervals = Object.keys(plan.prices);
    if (intervals.length === 0) problems.push(`plan "${plan.key}" has no price`);
    for (const [interval, amount] of Object.entries(plan.prices)) {
      if (interval !== "month" && interval !== "year") problems.push(`plan "${plan.key}": unknown interval "${interval}"`);
      const price = amount as number;
      if (!Number.isFinite(price) || price <= 0) problems.push(`plan "${plan.key}": ${interval} price must be above 0`);
      else if (hasSubCentPrecision(price)) problems.push(`plan "${plan.key}": ${interval} price has more than two decimals`);
    }
  }
  for (const product of config.products) {
    if (!Number.isFinite(product.price) || product.price <= 0) problems.push(`product "${product.key}": price must be above 0`);
    else if (hasSubCentPrecision(product.price)) problems.push(`product "${product.key}": price has more than two decimals`);
  }
  if (!/^[A-Z]{3}$/.test(config.currency)) problems.push(`currency "${config.currency}" is not an ISO 4217 code`);
  return problems;
}

/** Major units to the minor units Paddle wants, as a string ("9.99" -> "999"). Rounds half away from zero on the cent. */
export function toMinorUnits(amount: number): string {
  return String(Math.round(amount * 100));
}
