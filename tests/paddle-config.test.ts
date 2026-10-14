import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getPaddleServerConfig, paddleClientConfig, paddleConfigProblem, paddleConfigured, PaddleConfigError, paddleServerProblem } from "@/lib/billing/paddle/config";

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

  it("separates what a checkout needs from what an existing subscriber's portal needs (no browser token for the second)", () => {
    const noToken = env({ NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: undefined });
    assert.equal(paddleServerProblem(noToken), null);
    assert.match(paddleConfigProblem(noToken) ?? "", /NEXT_PUBLIC_PADDLE_CLIENT_TOKEN/);
    assert.match(paddleServerProblem({}) ?? "", /PADDLE_API_KEY/);
    assert.equal(paddleConfigProblem(base), null);
  });

  it("gives the browser only the token and the environment", () => {
    assert.deepEqual(paddleClientConfig(base), { token: "test_abc", environment: "sandbox" });
    assert.deepEqual(paddleClientConfig({}), { token: null, environment: "sandbox" });
  });
});
