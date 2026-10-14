import { paddleConfigOrResponse, errorResponse, webhookContext } from "@/lib/paddle/route-helpers";
import { verifyPaddleSignature } from "@/lib/paddle/signature";
import { supabaseBillingStore } from "@/lib/paddle/store";
import { parsePaddleEvent, processPaddleDelivery } from "@/lib/paddle/webhook";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Paddle webhook. Point a notification destination at `https://<your domain>/api/webhooks/paddle` (`npm run paddle:webhook`).
 *
 * Order matters: the signature is checked on the RAW body before anything is parsed, the event is claimed (idempotency) before it is
 * applied, and any failure answers 500 so that Paddle delivers it again. The rules for what is believed are in src/lib/paddle/webhook.ts.
 */
export async function POST(request: Request) {
  const configured = paddleConfigOrResponse();
  if ("response" in configured) return configured.response;
  const { config } = configured;
  // A missing secret must never mean "accept everything".
  if (!config.webhookSecret) return errorResponse("webhook_secret_not_configured", 503);

  const rawBody = await request.text();
  if (!verifyPaddleSignature(config.webhookSecret, rawBody, request.headers.get("paddle-signature"))) {
    return errorResponse("invalid_signature", 401);
  }

  const event = parsePaddleEvent(rawBody);
  if (!event) return errorResponse("invalid_event", 400);

  const admin = createAdminClient();
  if (!admin) {
    console.error("[paddle] SUPABASE_SERVICE_ROLE_KEY (or the Supabase URL) is not set: the webhook cannot write");
    return errorResponse("supabase_admin_not_configured", 503);
  }

  try {
    const result = await processPaddleDelivery(supabaseBillingStore(admin), event, webhookContext(config));
    return Response.json({ ok: true, status: result.status });
  } catch (error) {
    console.error(`[paddle] webhook ${event.event_type} ${event.event_id} failed:`, error);
    return errorResponse("webhook_failed", 500);
  }
}
