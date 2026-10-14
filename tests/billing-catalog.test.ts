import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BILLING_PROVIDERS, billingConfig, catalogItems, priceEnvName, productEnvName, providerEnvName, toMinorUnits, validateBillingConfig } from "@/config/billing";
import { itemForProviderRef, providerRefFor, sellableItems } from "@/lib/billing/catalog";

describe("env var names", () => {
  it("names the Paddle price var after the plan and the interval", () => {
    assert.equal(priceEnvName({ key: "pro", interval: "month" }), "PADDLE_PRICE_PRO_MONTH");
    assert.equal(priceEnvName({ key: "team", interval: "year" }), "PADDLE_PRICE_TEAM_YEAR");
    assert.equal(priceEnvName({ key: "credits_100", interval: null }), "PADDLE_PRICE_CREDITS_100");
  });

  it("names the Polar product var the same way (a Polar product has one interval)", () => {
    assert.equal(productEnvName({ key: "pro", interval: "month" }), "POLAR_PRODUCT_PRO_MONTH");
    assert.equal(productEnvName({ key: "team", interval: "year" }), "POLAR_PRODUCT_TEAM_YEAR");
    assert.equal(productEnvName({ key: "credits_100", interval: null }), "POLAR_PRODUCT_CREDITS_100");
    assert.equal(providerEnvName("paddle", { key: "pro", interval: "month" }), "PADDLE_PRICE_PRO_MONTH");
    assert.equal(providerEnvName("polar", { key: "pro", interval: "month" }), "POLAR_PRODUCT_PRO_MONTH");
  });

  it("knows exactly two providers", () => {
    assert.deepEqual([...BILLING_PROVIDERS], ["paddle", "polar"]);
  });
});

describe("a provider's ids, in both directions", () => {
  const paddle = { PADDLE_PRICE_PRO_MONTH: "pri_a", PADDLE_PRICE_PRO_YEAR: " pri_b " };
  const polar = { POLAR_PRODUCT_PRO_MONTH: "prod_a", POLAR_PRODUCT_PRO_YEAR: "prod_b" };

  it("looks the id of an item up, trimmed, and null while it is not in .env", () => {
    assert.equal(providerRefFor("paddle", { key: "pro", interval: "month" }, paddle), "pri_a");
    assert.equal(providerRefFor("paddle", { key: "pro", interval: "year" }, paddle), "pri_b");
    assert.equal(providerRefFor("paddle", { key: "team", interval: "month" }, paddle), null);
    assert.equal(providerRefFor("polar", { key: "pro", interval: "month" }, polar), "prod_a");
  });

  it("finds our item from an id, and an id that is not in .env is not ours", () => {
    assert.deepEqual({ key: itemForProviderRef("paddle", "pri_b", paddle)?.key, interval: itemForProviderRef("paddle", "pri_b", paddle)?.interval }, { key: "pro", interval: "year" });
    assert.equal(itemForProviderRef("polar", "prod_a", polar)?.interval, "month");
    assert.equal(itemForProviderRef("paddle", "pri_other", paddle), null);
    assert.equal(itemForProviderRef("paddle", undefined, paddle), null);
    assert.equal(itemForProviderRef("paddle", "", paddle), null);
  });

  it("never mixes the providers: a Polar product id is nothing to Paddle and the other way round", () => {
    const both = { ...paddle, ...polar };
    assert.equal(itemForProviderRef("paddle", "prod_a", both), null);
    assert.equal(itemForProviderRef("polar", "pri_a", both), null);
  });

  it("lists what a provider can sell right now: the items whose id is in .env", () => {
    assert.deepEqual(sellableItems("paddle", paddle).map((item) => `${item.key}:${item.interval}`), ["pro:month", "pro:year"]);
    assert.deepEqual(sellableItems("polar", paddle), []);
  });
});

describe("src/config/billing.ts", () => {
  it("ships valid", () => {
    assert.deepEqual(validateBillingConfig(), []);
  });

  it("lists one catalog item per plan interval and per product", () => {
    const items = catalogItems();
    assert.equal(items.length, billingConfig.plans.reduce((n, plan) => n + Object.keys(plan.prices).length, 0));
    assert.ok(items.every((item) => item.kind === "plan" && item.interval));
  });

  it("catches the mistakes that would only show up as a broken checkout", () => {
    const plan = { key: "pro", name: "Pro", description: "d", features: [], prices: { month: 9 } };
    const check = (plans: unknown[], products: unknown[] = [], currency = "USD") => validateBillingConfig({ currency, plans, products } as Parameters<typeof validateBillingConfig>[0]);
    assert.deepEqual(check([plan]), []);
    assert.match(check([plan, plan]).join(), /used twice/);
    assert.match(check([{ ...plan, key: "Pro Plan" }]).join(), /lowercase/);
    assert.match(check([{ ...plan, prices: {} }]).join(), /no price/);
    assert.match(check([{ ...plan, prices: { month: 0 } }]).join(), /above 0/);
    assert.match(check([{ ...plan, prices: { month: 9.999 } }]).join(), /two decimals/);
    assert.match(check([{ ...plan, prices: { week: 3 } }]).join(), /unknown interval/);
    assert.match(check([plan], [{ key: "pro", name: "x", description: "x", price: 5 }]).join(), /used twice/);
    assert.match(check([plan], [], "usd").join(), /ISO 4217/);
  });

  it("converts to the minor units the providers want without floating point drift", () => {
    assert.equal(toMinorUnits(9), "900");
    assert.equal(toMinorUnits(9.99), "999");
    assert.equal(toMinorUnits(19.9), "1990");
    assert.equal(toMinorUnits(0.07), "7");
    assert.equal(toMinorUnits(1.005 * 100), "10050");
  });
});
