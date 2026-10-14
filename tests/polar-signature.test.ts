import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { polarWebhookHeaders, SIGNATURE_TOLERANCE_SECONDS, signPolarBody, verifyPolarSignature, type PolarWebhookHeaders } from "@/lib/billing/polar/signature";

// A Standard Webhooks secret: "whsec_" + base64 of the key. Written out here so the test does not use the code it checks.
const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${KEY.toString("base64")}`;
const BODY = JSON.stringify({ type: "order.paid", timestamp: "2026-10-14T00:00:00Z", data: { id: "ord_1" } });
const NOW = Date.UTC(2026, 9, 14, 0, 0, 30);
const seconds = (ms: number) => Math.floor(ms / 1000);

const headersFor = (key: Buffer, over: Partial<PolarWebhookHeaders> = {}, ts = seconds(NOW), id = "msg_1", body = BODY): PolarWebhookHeaders => ({
  id,
  timestamp: String(ts),
  signature: `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`,
  ...over,
});

describe("verifyPolarSignature (Standard Webhooks)", () => {
  it("accepts a correctly signed body", () => {
    assert.equal(verifyPolarSignature(SECRET, BODY, headersFor(KEY), NOW), true);
  });

  it("round-trips with signPolarBody", () => {
    const signed = signPolarBody(SECRET, "msg_2", BODY, NOW);
    const headers = polarWebhookHeaders(new Headers(signed));
    assert.equal(verifyPolarSignature(SECRET, BODY, headers, NOW), true);
  });

  it("agrees with the reference library when it is installed", async () => {
    let library: { Webhook: new (secret: string) => { sign: (id: string, date: Date, body: string) => string } };
    try {
      const name = "standardwebhooks"; // a variable: not a dependency of the template, so TypeScript must not look for it
      library = await import(name);
    } catch {
      return; // not a dependency of the template: this check only runs where somebody installed it
    }
    const signature = new library.Webhook(SECRET).sign("msg_lib", new Date(NOW), BODY);
    assert.equal(verifyPolarSignature(SECRET, BODY, { id: "msg_lib", timestamp: String(seconds(NOW)), signature }, NOW), true);
  });

  it("also accepts the older Polar secrets, whose key is the whole secret string", () => {
    const legacy = "polar_whs_legacy_secret";
    assert.equal(verifyPolarSignature(legacy, BODY, headersFor(Buffer.from(legacy, "utf8")), NOW), true);
  });

  it("refuses a body that was changed by one byte, even one that parses to the same JSON", () => {
    assert.equal(verifyPolarSignature(SECRET, `${BODY} `, headersFor(KEY), NOW), false);
    assert.equal(verifyPolarSignature(SECRET, JSON.stringify(JSON.parse(BODY), null, 2), headersFor(KEY), NOW), false);
  });

  it("refuses another secret and a missing secret", () => {
    assert.equal(verifyPolarSignature(`whsec_${Buffer.from("another key entirely, 32 bytes!!!").toString("base64")}`, BODY, headersFor(KEY), NOW), false);
    assert.equal(verifyPolarSignature("", BODY, headersFor(KEY), NOW), false);
  });

  it("refuses missing or malformed headers", () => {
    const good = headersFor(KEY);
    for (const bad of [
      { ...good, id: null },
      { ...good, id: "" },
      { ...good, timestamp: undefined },
      { ...good, timestamp: "yesterday" },
      { ...good, signature: null },
      { ...good, signature: "" },
      { ...good, signature: "garbage" },
      { ...good, signature: "v2,AAAA" },
      { ...good, signature: "v1," },
      { ...good, signature: "v1,AAAA" },
    ]) {
      assert.equal(verifyPolarSignature(SECRET, BODY, bad, NOW), false, JSON.stringify(bad));
    }
  });

  it("does not accept a signature made for another delivery id or another timestamp", () => {
    assert.equal(verifyPolarSignature(SECRET, BODY, { ...headersFor(KEY), id: "msg_other" }, NOW), false);
    const signedForEarlier = headersFor(KEY, {}, seconds(NOW) - 10);
    assert.equal(verifyPolarSignature(SECRET, BODY, { ...signedForEarlier, timestamp: String(seconds(NOW)) }, NOW), false);
  });

  it("refuses a timestamp outside the tolerance, in both directions", () => {
    const limit = SIGNATURE_TOLERANCE_SECONDS;
    assert.equal(verifyPolarSignature(SECRET, BODY, headersFor(KEY, {}, seconds(NOW) - limit), NOW), true);
    assert.equal(verifyPolarSignature(SECRET, BODY, headersFor(KEY, {}, seconds(NOW) - limit - 5), NOW), false);
    assert.equal(verifyPolarSignature(SECRET, BODY, headersFor(KEY, {}, seconds(NOW) + limit + 5), NOW), false);
  });

  it("accepts any one of several space separated signatures (a secret rotation)", () => {
    const wrong = `v1,${createHmac("sha256", "old").update(`msg_1.${seconds(NOW)}.${BODY}`).digest("base64")}`;
    const right = headersFor(KEY).signature!;
    assert.equal(verifyPolarSignature(SECRET, BODY, { ...headersFor(KEY), signature: `${wrong} ${right}` }, NOW), true);
    assert.equal(verifyPolarSignature(SECRET, BODY, { ...headersFor(KEY), signature: `${right} ${wrong}` }, NOW), true);
    assert.equal(verifyPolarSignature(SECRET, BODY, { ...headersFor(KEY), signature: wrong }, NOW), false);
  });
});
