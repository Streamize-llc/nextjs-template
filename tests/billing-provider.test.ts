import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseBillingProvider, providerConfigProblem, providerServerProblem } from "@/lib/billing/provider";

const PADDLE = { PADDLE_API_KEY: "pdl_sdbx_apikey_x", PADDLE_APP_TAG: "my-app", NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_abc" };
const POLAR = { POLAR_ACCESS_TOKEN: "polar_oat_x" };

describe("chooseBillingProvider: who takes NEW checkouts", () => {
  it("is the provider BILLING_PROVIDER names, when it is configured", () => {
    assert.deepEqual(chooseBillingProvider({ ...PADDLE, ...POLAR, BILLING_PROVIDER: "paddle" }), { provider: "paddle" });
    assert.deepEqual(chooseBillingProvider({ ...PADDLE, ...POLAR, BILLING_PROVIDER: "polar" }), { provider: "polar" });
    assert.deepEqual(chooseBillingProvider({ ...POLAR, BILLING_PROVIDER: " Polar " }), { provider: "polar" }, "case and spaces do not matter");
  });

  it("is an error, never a silent fallback, when the named provider is not configured", () => {
    const choice = chooseBillingProvider({ ...POLAR, BILLING_PROVIDER: "paddle" });
    assert.ok("error" in choice);
    assert.equal(choice.error, "billing_not_configured");
    assert.match(choice.reason, /BILLING_PROVIDER is paddle/);
    assert.match(choice.reason, /PADDLE_API_KEY/);
  });

  it("is an error for a name that is neither", () => {
    for (const name of ["stripe", "paddel", "both", "true"]) {
      const choice = chooseBillingProvider({ ...PADDLE, ...POLAR, BILLING_PROVIDER: name });
      assert.ok("error" in choice, name);
      assert.match(choice.reason, /"paddle" or "polar"/);
    }
  });

  it("without BILLING_PROVIDER it is the one provider that is configured", () => {
    assert.deepEqual(chooseBillingProvider(PADDLE), { provider: "paddle" });
    assert.deepEqual(chooseBillingProvider(POLAR), { provider: "polar" });
    assert.deepEqual(chooseBillingProvider({ ...POLAR, BILLING_PROVIDER: "" }), { provider: "polar" });
  });

  it("without BILLING_PROVIDER and with both configured it refuses to guess (a switch must be a decision)", () => {
    const choice = chooseBillingProvider({ ...PADDLE, ...POLAR });
    assert.ok("error" in choice);
    assert.match(choice.reason, /BILLING_PROVIDER/);
  });

  it("is an error when nothing is configured", () => {
    const choice = chooseBillingProvider({});
    assert.ok("error" in choice);
    assert.match(choice.reason, /no payment provider/);
  });
});

describe("what the old provider still needs after a switch", () => {
  it("a new checkout needs Paddle's browser token; an existing subscriber's portal and sync do not", () => {
    const withoutToken = { ...PADDLE, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: undefined };
    assert.match(providerConfigProblem("paddle", withoutToken) ?? "", /CLIENT_TOKEN/);
    assert.equal(providerServerProblem("paddle", withoutToken), null);
  });

  it("Polar needs the same for both", () => {
    assert.equal(providerConfigProblem("polar", POLAR), null);
    assert.equal(providerServerProblem("polar", POLAR), null);
    assert.match(providerServerProblem("polar", {}) ?? "", /POLAR_ACCESS_TOKEN/);
  });
});
