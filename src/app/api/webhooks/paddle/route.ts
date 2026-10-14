import { paddleWebhookContext } from "@/lib/billing/paddle/adapter";
import { paddleConfigOrResponse } from "@/lib/billing/paddle/route-helpers";
import { verifyPaddleSignature } from "@/lib/billing/paddle/signature";
import { parsePaddleEvent, processPaddleDelivery } from "@/lib/billing/paddle/webhook";
import { errorResponse } from "@/lib/billing/route-helpers";
import { supabaseBillingStore } from "@/lib/billing/store";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Paddle webhook. Point a notification destination at `https://<your domain>/api/webhooks/paddle` (`npm run paddle:webhook`).
 * It is processed whichever provider `BILLING_PROVIDER` names: subscribers who bought through Paddle keep being updated after a switch.
 *
 * Order matters: the signature is checked on the RAW body before anything is parsed, the event is claimed (idempotency) before it is
 * applied, and any failure answers 500 so that Paddle delivers it again. The rules for what is believed are in src/lib/billing/delivery.ts
 * and src/lib/billing/paddle/webhook.ts.
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
    const result = await processPaddleDelivery(supabaseBillingStore(admin), event, paddleWebhookContext(config.appTag));
    return Response.json({ ok: true, status: result.status });
  } catch (error) {
    console.error(`[paddle] webhook ${event.event_type} ${event.event_id} failed:`, error);
    return errorResponse("webhook_failed", 500);
  }
}
