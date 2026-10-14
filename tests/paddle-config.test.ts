import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billingConfig, catalogItems, priceEnvName, toMinorUnits, validateBillingConfig } from "@/config/billing";
import { getPaddleServerConfig, itemForPriceId, paddleClientConfig, paddleConfigured, PaddleConfigError, priceIdFor } from "@/lib/paddle/config";

const base = { PADDLE_API_KEY: "pdl_sdbx_apikey_x", PADDLE_APP_TAG: "my-app", NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_abc" };
const env = (extra: Record<string, string | undefined>) => ({ ...base, ...extra });

describe("getPaddleServerConfig", () => {
  it("reads a complete sandbox configuration (sandbox is the default environment)", () => {
    const config = getPaddleServerConfig(base);
    assert.equal(config.environment, "sandbox");
    assert.equal(config.apiBase, "https://sandbox-api.paddle.com");
    assert.equal(config.appTag, "my-app");
    assert.equal(config.webhookSecret, null);
    assert.equal(getPaddleServerConfig(env({ PADDLE_WEBHOOK_SECRET: " pdl_ntfset_x " })).webhookSecret, "pdl_ntfset_x");
  });

  it("reads a live configuration only with a live key", () => {
    const live = env({ NEXT_PUBLIC_PADDLE_ENVIRONMENT: "production", PADDLE_API_KEY: "pdl_live_apikey_x" });
    assert.equal(getPaddleServerConfig(live).apiBase, "https://api.paddle.com");
  });

  it("refuses a sandbox key in production and a live key in the sandbox, the two mistakes that charge the wrong account", () => {
    assert.throws(() => getPaddleServerConfig(env({ NEXT_PUBLIC_PADDLE_ENVIRONMENT: "production" })), PaddleConfigError);
    assert.throws(() => getPaddleServerConfig(env({ PADDLE_API_KEY: "pdl_live_apikey_x" })), PaddleConfigError);
  });

  it("refuses a missing key and a missing or malformed app tag", () => {
    assert.throws(() => getPaddleServerConfig(env({ PADDLE_API_KEY: undefined })), /PADDLE_API_KEY/);
    for (const tag of [undefined, "", "x", "My App", "UPPER", "-lead", "a".repeat(60)]) {
      assert.throws(() => getPaddleServerConfig(env({ PADDLE_APP_TAG: tag })), /PADDLE_APP_TAG/, String(tag));
    }
  });
});

describe("paddleConfigured and the client config", () => {
  it("is true only when the key, the tag and the browser token are all there", () => {
    assert.equal(paddleConfigured(base), true);
    assert.equal(paddleConfigured(env({ NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: undefined })), false);
    assert.equal(paddleConfigured(env({ PADDLE_APP_TAG: undefined })), false);
    assert.equal(paddleConfigured({}), false);
  });

  it("gives the browser only the token and the environment", () => {
    assert.deepEqual(paddleClientConfig(base), { token: "test_abc", environment: "sandbox" });
    assert.deepEqual(paddleClientConfig({}), { token: null, environment: "sandbox" });
  });
});

describe("price ids", () => {
  it("names the env var after the plan and the interval", () => {
    assert.equal(priceEnvName({ key: "pro", interval: "month" }), "PADDLE_PRICE_PRO_MONTH");
    assert.equal(priceEnvName({ key: "team", interval: "year" }), "PADDLE_PRICE_TEAM_YEAR");
    assert.equal(priceEnvName({ key: "credits_100", interval: null }), "PADDLE_PRICE_CREDITS_100");
  });

  it("looks a price up in both directions, and a price that is not in .env is not ours", () => {
    const e = env({ PADDLE_PRICE_PRO_MONTH: "pri_a", PADDLE_PRICE_PRO_YEAR: " pri_b " });
    assert.equal(priceIdFor({ key: "pro", interval: "month" }, e), "pri_a");
    assert.equal(priceIdFor({ key: "pro", interval: "year" }, e), "pri_b");
    assert.equal(priceIdFor({ key: "team", interval: "month" }, e), null);
    assert.deepEqual(itemForPriceId("pri_b", e) && { key: itemForPriceId("pri_b", e)?.key, interval: itemForPriceId("pri_b", e)?.interval }, { key: "pro", interval: "year" });
    assert.equal(itemForPriceId("pri_other", e), null);
    assert.equal(itemForPriceId(undefined, e), null);
    assert.equal(itemForPriceId("", e), null);
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

  it("converts to the minor units Paddle wants without floating point drift", () => {
    assert.equal(toMinorUnits(9), "900");
    assert.equal(toMinorUnits(9.99), "999");
    assert.equal(toMinorUnits(19.9), "1990");
    assert.equal(toMinorUnits(0.07), "7");
    assert.equal(toMinorUnits(1.005 * 100), "10050");
  });
});
