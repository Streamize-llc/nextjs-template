import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getPolarServerConfig, polarConfigProblem, polarConfigured, PolarConfigError, polarServer } from "@/lib/billing/polar/config";

describe("getPolarServerConfig", () => {
  it("is the sandbox unless POLAR_SERVER says production exactly, so a typo can never charge for real", () => {
    assert.equal(polarServer({}), "sandbox");
    assert.equal(polarServer({ POLAR_SERVER: "production" }), "production");
    for (const other of ["Production", "prod", "live", "", "sandbox"]) assert.equal(polarServer({ POLAR_SERVER: other }), "sandbox", other);
  });

  it("reads the token, the API base of the server and the webhook secret", () => {
    const sandbox = getPolarServerConfig({ POLAR_ACCESS_TOKEN: " polar_oat_x " });
    assert.equal(sandbox.accessToken, "polar_oat_x");
    assert.equal(sandbox.apiBase, "https://sandbox-api.polar.sh");
    assert.equal(sandbox.webhookSecret, null);
    const live = getPolarServerConfig({ POLAR_ACCESS_TOKEN: "t", POLAR_SERVER: "production", POLAR_WEBHOOK_SECRET: " whsec_x " });
    assert.equal(live.apiBase, "https://api.polar.sh");
    assert.equal(live.webhookSecret, "whsec_x");
  });

  it("refuses a missing or blank token", () => {
    for (const token of [undefined, "", "   "]) assert.throws(() => getPolarServerConfig({ POLAR_ACCESS_TOKEN: token }), PolarConfigError);
  });
});

describe("polarConfigured", () => {
  it("needs only the token (Polar needs nothing in the browser)", () => {
    assert.equal(polarConfigured({ POLAR_ACCESS_TOKEN: "t" }), true);
    assert.equal(polarConfigured({}), false);
    assert.match(polarConfigProblem({}) ?? "", /POLAR_ACCESS_TOKEN/);
    assert.equal(polarConfigProblem({ POLAR_ACCESS_TOKEN: "t" }), null);
  });
});
