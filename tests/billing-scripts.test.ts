// The scripts (plain Node, no `@/` imports) repeat a few rules of the library. These tests keep the copies in step with the originals.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { chooseBillingProvider } from "@/lib/billing/provider";
import { PADDLE_EVENTS } from "@/lib/billing/paddle/webhook";
import { productProblems } from "@/lib/billing/polar/product-check";
import { POLAR_EVENTS } from "@/lib/billing/polar/webhook";

const root = new URL("../", import.meta.url);
const script = (name: string) => readFileSync(new URL(`scripts/${name}`, root), "utf8");
const listIn = (source: string): string[] => {
  const block = /const EVENTS = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
};

describe("scripts/billing-check.mjs agrees with chooseBillingProvider", () => {
  const PADDLE = { PADDLE_API_KEY: "pdl_sdbx_apikey_x", PADDLE_APP_TAG: "my-app", NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_abc" };
  const POLAR = { POLAR_ACCESS_TOKEN: "polar_oat_x" };
  const cases: Record<string, Record<string, string>> = {
    "nothing configured": {},
    "only Paddle": PADDLE,
    "only Polar": POLAR,
    "both, no choice": { ...PADDLE, ...POLAR },
    "both, Paddle": { ...PADDLE, ...POLAR, BILLING_PROVIDER: "paddle" },
    "both, Polar": { ...PADDLE, ...POLAR, BILLING_PROVIDER: "polar" },
    "both, Polar in capitals with spaces": { ...PADDLE, ...POLAR, BILLING_PROVIDER: " POLAR " },
    "Paddle named but only Polar configured": { ...POLAR, BILLING_PROVIDER: "paddle" },
    "a name that is neither": { ...PADDLE, ...POLAR, BILLING_PROVIDER: "stripe" },
    "Paddle without the browser token": { ...PADDLE, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "", ...POLAR },
    "a live key in the sandbox": { ...PADDLE, PADDLE_API_KEY: "pdl_live_apikey_x", BILLING_PROVIDER: "paddle" },
  };

  for (const [name, env] of Object.entries(cases)) {
    it(name, () => {
      const run = spawnSync(process.execPath, ["--no-warnings", new URL("scripts/billing-check.mjs", root).pathname], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
      const choice = chooseBillingProvider(env);
      const line = /New checkouts: (\w+)/.exec(run.stdout)?.[1];
      assert.equal(line, "provider" in choice ? choice.provider : "none", run.stdout);
      assert.equal(run.status, "provider" in choice ? 0 : 1);
    });
  }
});

describe("the webhook event lists", () => {
  it("scripts/polar-setup.mjs registers exactly the events the Polar handler knows", () => {
    assert.deepEqual(listIn(script("polar-setup.mjs")), [...POLAR_EVENTS].sort());
  });

  it("scripts/paddle-setup.mjs registers exactly the events the Paddle handler knows", () => {
    assert.deepEqual(listIn(script("paddle-setup.mjs")), [...PADDLE_EVENTS].sort());
  });
});

describe("productProblems: does a Polar product match the catalog?", () => {
  // The shape of a real Polar sandbox product (field names and types read from the API).
  const monthly9 = { id: "p1", is_archived: false, recurring_interval: "month", prices: [{ is_archived: false, amount_type: "fixed", price_amount: 900, price_currency: "usd", type: "recurring", recurring_interval: "month" }] };
  const oneTime10 = { id: "p2", is_archived: false, recurring_interval: null, prices: [{ is_archived: false, amount_type: "fixed", price_amount: 1000, price_currency: "usd", type: "one_time", recurring_interval: null }] };

  it("accepts a product that is what the catalog says", () => {
    assert.deepEqual(productProblems(monthly9, { interval: "month", amountMinor: 900, currency: "USD" }), []);
    assert.deepEqual(productProblems(oneTime10, { interval: null, amountMinor: 1000, currency: "usd" }), []);
  });

  it("names every difference: interval, price, currency, archived, free or pay-what-you-want, several prices, none", () => {
    assert.match(productProblems(monthly9, { interval: "year", amountMinor: 900, currency: "USD" }).join(), /every month.*every year/);
    assert.match(productProblems(monthly9, { interval: null, amountMinor: 900, currency: "USD" }).join(), /one-time/);
    assert.match(productProblems(oneTime10, { interval: "month", amountMinor: 1000, currency: "USD" }).join(), /once/);
    assert.match(productProblems(monthly9, { interval: "month", amountMinor: 990, currency: "USD" }).join(), /900.*990/);
    assert.match(productProblems(monthly9, { interval: "month", amountMinor: 900, currency: "KRW" }).join(), /currency/);
    assert.match(productProblems({ ...monthly9, is_archived: true }, { interval: "month", amountMinor: 900, currency: "USD" }).join(), /archived/);
    assert.match(productProblems({ ...monthly9, prices: [{ ...monthly9.prices[0], amount_type: "free" }] }, { interval: "month", amountMinor: 900, currency: "USD" }).join(), /not a fixed amount/);
    assert.match(productProblems({ ...monthly9, prices: [monthly9.prices[0], { ...monthly9.prices[0], price_amount: 500 }] }, { interval: "month", amountMinor: 900, currency: "USD" }).join(), /2 active prices/);
    assert.match(productProblems({ ...monthly9, prices: [{ ...monthly9.prices[0], is_archived: true }] }, { interval: "month", amountMinor: 900, currency: "USD" }).join(), /no active price/);
    assert.match(productProblems({}, { interval: "month", amountMinor: 900, currency: "USD" }).join(), /no active price/);
  });

  it("ignores an archived price next to the live one", () => {
    const withOld = { ...monthly9, prices: [{ ...monthly9.prices[0], is_archived: true, price_amount: 500 }, monthly9.prices[0]] };
    assert.deepEqual(productProblems(withOld, { interval: "month", amountMinor: 900, currency: "USD" }), []);
  });
});
