/**
 * Verifies a Polar webhook: Polar signs with the Standard Webhooks scheme (https://www.standardwebhooks.com). Three headers come with the
 * RAW body: `webhook-id`, `webhook-timestamp` (unix seconds) and `webhook-signature` (space separated `v1,<base64>` entries). The signature is
 * the HMAC-SHA256 of `${id}.${timestamp}.${rawBody}`. The RAW body must be used, byte for byte: a body that was parsed and re-serialised never matches.
 *
 * Two key schemes exist, depending on when the secret was created, and both are accepted (the same rule as `standardwebhooks` plus Polar's
 * older secrets): the secret without its `whsec_` prefix, base64-decoded; or the whole secret string as it is. Redelivery of an old, valid
 * request is handled by event-id idempotency (../delivery.ts), so the timestamp only has to absorb clock skew.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface PolarWebhookHeaders {
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
}

/** The headers of a request (case does not matter: `Headers` is case-insensitive already). */
export function polarWebhookHeaders(headers: Pick<Headers, "get">): PolarWebhookHeaders {
  return { id: headers.get("webhook-id"), timestamp: headers.get("webhook-timestamp"), signature: headers.get("webhook-signature") };
}

function signingKeys(secret: string): Buffer[] {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return [Buffer.from(encoded, "base64"), Buffer.from(secret, "utf8")];
}

export function verifyPolarSignature(secret: string, rawBody: string, headers: PolarWebhookHeaders, nowMs = Date.now()): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const age = Math.abs(nowMs / 1000 - Number(headers.timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;

  const signed = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const given = headers.signature
    .split(" ")
    .map((entry) => entry.split(","))
    .filter(([version, value]) => version === "v1" && Boolean(value))
    .map(([, value]) => Buffer.from(value, "base64"));
  if (given.length === 0) return false;

  return signingKeys(secret).some((key) => {
    const expected = createHmac("sha256", key).update(signed).digest();
    return given.some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected));
  });
}

/** For tests and for `scripts/polar-setup.mjs send-test`: headers the verifier above accepts (the Standard Webhooks key scheme). */
export function signPolarBody(secret: string, id: string, rawBody: string, nowMs = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  const key = signingKeys(secret)[0];
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
}
