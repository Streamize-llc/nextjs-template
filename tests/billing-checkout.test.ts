import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCheckoutRequest, resolveCheckoutItem } from "@/lib/billing/checkout";
import { ENV, ITEMS, POLAR_ENV } from "./support/billing-fixtures";

describe("parseCheckoutRequest", () => {
  it("accepts a plan with an interval and a product without one", () => {
    assert.deepEqual(parseCheckoutRequest({ kind: "plan", key: "pro", interval: "month" }), { kind: "plan", key: "pro", interval: "month" });
    assert.deepEqual(parseCheckoutRequest({ kind: "plan", key: "pro", interval: "year" }), { kind: "plan", key: "pro", interval: "year" });
    assert.deepEqual(parseCheckoutRequest({ kind: "product", key: "credits_100" }), { kind: "product", key: "credits_100", interval: null });
  });

  it("refuses anything the browser should not be sending", () => {
    for (const bad of [null, undefined, "plan", 7, [], {}, { kind: "plan", key: "pro" }, { kind: "plan", key: "pro", interval: "week" }, { kind: "plan", key: "", interval: "month" }, { kind: "plan", key: "x".repeat(41), interval: "month" }, { kind: "bundle", key: "pro" }, { kind: "plan", key: 3, interval: "month" }]) {
      assert.equal(parseCheckoutRequest(bad), null, JSON.stringify(bad));
    }
  });

  it("ignores a price, an amount, a customer or a provider in the body: only the name of the thing counts", () => {
    assert.deepEqual(parseCheckoutRequest({ kind: "plan", key: "pro", interval: "month", priceId: "pri_free", amount: 1, customerId: "ctm_x", provider: "polar", productId: "prod_free" }), { kind: "plan", key: "pro", interval: "month" });
  });
});

describe("resolveCheckoutItem", () => {
  it("finds the item and the Paddle price id from the environment", () => {
    const resolved = resolveCheckoutItem({ kind: "plan", key: "pro", interval: "year" }, "paddle", ENV, ITEMS);
    assert.ok(!("error" in resolved));
    assert.equal(resolved.ref, "pri_pro_year");
    assert.equal(resolved.item.key, "pro");
    const product = resolveCheckoutItem({ kind: "product", key: "credits_100", interval: null }, "paddle", ENV, ITEMS);
    assert.ok(!("error" in product));
    assert.equal(product.ref, "pri_credits_100");
  });

  it("finds the Polar product id of the same item, and never a Paddle id for Polar", () => {
    const resolved = resolveCheckoutItem({ kind: "plan", key: "pro", interval: "year" }, "polar", POLAR_ENV, ITEMS);
    assert.ok(!("error" in resolved));
    assert.equal(resolved.ref, "prod_pro_year");
    // only the Paddle ids are configured: Polar has nothing to sell
    assert.deepEqual(resolveCheckoutItem({ kind: "plan", key: "pro", interval: "year" }, "polar", ENV, ITEMS), { error: "price_not_configured" });
    assert.deepEqual(resolveCheckoutItem({ kind: "plan", key: "pro", interval: "year" }, "paddle", POLAR_ENV, ITEMS), { error: "price_not_configured" });
  });

  it("says unknown_item for a plan, an interval or a product that is not in src/config/billing.ts", () => {
    assert.deepEqual(resolveCheckoutItem({ kind: "plan", key: "enterprise", interval: "month" }, "paddle", ENV, ITEMS), { error: "unknown_item" });
    assert.deepEqual(resolveCheckoutItem({ kind: "product", key: "pro", interval: null }, "paddle", ENV, ITEMS), { error: "unknown_item" });
    assert.deepEqual(resolveCheckoutItem({ kind: "plan", key: "credits_100", interval: "month" }, "polar", POLAR_ENV, ITEMS), { error: "unknown_item" });
  });

  it("says price_not_configured while the id is not in .env yet", () => {
    assert.deepEqual(resolveCheckoutItem({ kind: "plan", key: "pro", interval: "month" }, "paddle", {}, ITEMS), { error: "price_not_configured" });
    assert.deepEqual(resolveCheckoutItem({ kind: "plan", key: "pro", interval: "month" }, "polar", {}, ITEMS), { error: "price_not_configured" });
  });
});
