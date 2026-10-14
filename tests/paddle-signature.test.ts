import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { SIGNATURE_TOLERANCE_SECONDS, signPaddleBody, verifyPaddleSignature } from "@/lib/paddle/signature";

const SECRET = "pdl_ntfset_secret";
const BODY = JSON.stringify({ event_id: "evt_1", event_type: "subscription.created", occurred_at: "2026-10-14T00:00:00Z", data: {} });
const NOW = Date.UTC(2026, 9, 14, 0, 0, 30);
const header = (ts: number, secret = SECRET, body = BODY) => `ts=${ts};h1=${createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex")}`;
const seconds = (ms: number) => Math.floor(ms / 1000);

describe("verifyPaddleSignature", () => {
  it("accepts a correctly signed body", () => {
    assert.equal(verifyPaddleSignature(SECRET, BODY, header(seconds(NOW)), NOW), true);
  });

  it("round-trips with signPaddleBody", () => {
    assert.equal(verifyPaddleSignature(SECRET, BODY, signPaddleBody(SECRET, BODY, NOW), NOW), true);
  });

  it("refuses a body that was changed by one byte, even one that parses to the same JSON", () => {
    assert.equal(verifyPaddleSignature(SECRET, `${BODY} `, header(seconds(NOW)), NOW), false);
    assert.equal(verifyPaddleSignature(SECRET, JSON.stringify(JSON.parse(BODY), null, 2), header(seconds(NOW)), NOW), false);
  });

  it("refuses another secret, a missing secret and a missing or malformed header", () => {
    assert.equal(verifyPaddleSignature("other", BODY, header(seconds(NOW)), NOW), false);
    assert.equal(verifyPaddleSignature("", BODY, header(seconds(NOW), ""), NOW), false);
    for (const bad of [null, undefined, "", "garbage", "ts=1", "h1=abc", `ts=${seconds(NOW)}`, `ts=abc;h1=${"0".repeat(64)}`, `ts=${seconds(NOW)};h1=short`]) {
      assert.equal(verifyPaddleSignature(SECRET, BODY, bad, NOW), false, String(bad));
    }
  });

  it("refuses a timestamp outside the tolerance, in both directions", () => {
    const limit = SIGNATURE_TOLERANCE_SECONDS;
    assert.equal(verifyPaddleSignature(SECRET, BODY, header(seconds(NOW) - limit), NOW), true);
    assert.equal(verifyPaddleSignature(SECRET, BODY, header(seconds(NOW) - limit - 5), NOW), false);
    assert.equal(verifyPaddleSignature(SECRET, BODY, header(seconds(NOW) + limit + 5), NOW), false);
  });

  it("accepts any one of several h1 values (a secret rotation signs with both secrets)", () => {
    const ts = seconds(NOW);
    const wrong = createHmac("sha256", "old").update(`${ts}:${BODY}`).digest("hex");
    const right = createHmac("sha256", SECRET).update(`${ts}:${BODY}`).digest("hex");
    assert.equal(verifyPaddleSignature(SECRET, BODY, `ts=${ts};h1=${wrong};h1=${right}`, NOW), true);
    assert.equal(verifyPaddleSignature(SECRET, BODY, `ts=${ts};h1=${right};h1=${wrong}`, NOW), true);
    assert.equal(verifyPaddleSignature(SECRET, BODY, `ts=${ts};h1=${wrong}`, NOW), false);
  });

  it("does not trust the timestamp alone: the timestamp is part of what is signed", () => {
    const ts = seconds(NOW);
    const signedForAnotherTime = header(ts - 10).replace(`ts=${ts - 10}`, `ts=${ts}`);
    assert.equal(verifyPaddleSignature(SECRET, BODY, signedForAnotherTime, NOW), false);
  });
});
