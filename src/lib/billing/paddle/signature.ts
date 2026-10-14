/**
 * Verifies the `Paddle-Signature` header of a webhook: `ts=<unix seconds>;h1=<hex>`, an HMAC-SHA256 of `${ts}:${rawBody}` with the
 * notification destination's secret. The RAW request body must be used, byte for byte: a body that was parsed and re-serialised never matches.
 *
 * While a secret is being rotated Paddle signs with both secrets and sends several `h1` values: any one that matches is enough.
 * Redelivery of an old, valid request is handled by event-id idempotency (webhook.ts), so the timestamp only has to absorb clock skew.
 * https://developer.paddle.com/webhooks/signature-verification
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyPaddleSignature(secret: string, rawBody: string, header: string | null | undefined, nowMs = Date.now()): boolean {
  if (!secret || !header) return false;
  let ts: string | null = null;
  const candidates: string[] = [];
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "ts") ts = value;
    else if (key === "h1") candidates.push(value);
  }
  if (!ts || candidates.length === 0) return false;
  const age = Math.abs(nowMs / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex"));
  return candidates.some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** For tests and for `scripts/paddle-setup.mjs send-test`: a header the verifier above accepts. */
export function signPaddleBody(secret: string, rawBody: string, nowMs = Date.now()): string {
  const ts = String(Math.floor(nowMs / 1000));
  return `ts=${ts};h1=${createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex")}`;
}
