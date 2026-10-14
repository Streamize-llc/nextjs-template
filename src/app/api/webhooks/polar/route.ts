import { polarContext } from "@/lib/billing/polar/adapter";
import { polarConfigOrResponse } from "@/lib/billing/polar/route-helpers";
import { polarWebhookHeaders, verifyPolarSignature } from "@/lib/billing/polar/signature";
import { parsePolarEvent, processPolarDelivery } from "@/lib/billing/polar/webhook";
import { errorResponse } from "@/lib/billing/route-helpers";
import { supabaseBillingStore } from "@/lib/billing/store";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Polar webhook. Register an endpoint at `https://<your domain>/api/webhooks/polar` with the format "Raw" (`npm run polar:webhook`).
 * It is processed whichever provider `BILLING_PROVIDER` names: subscribers who bought through Polar keep being updated after a switch.
 *
 * Order matters: the signature is checked on the RAW body before anything is parsed, the delivery is claimed (idempotency) before it is
 * applied, and any failure answers 500 so that Polar delivers it again. The rules for what is believed are in src/lib/billing/delivery.ts
 * and src/lib/billing/polar/webhook.ts.
 */
export async function POST(request: Request) {
  const configured = polarConfigOrResponse();
  if ("response" in configured) return configured.response;
  const { config } = configured;
  // A missing secret must never mean "accept everything".
  if (!config.webhookSecret) return errorResponse("webhook_secret_not_configured", 503);

  const rawBody = await request.text();
  const headers = polarWebhookHeaders(request.headers);
  if (!verifyPolarSignature(config.webhookSecret, rawBody, headers)) return errorResponse("invalid_signature", 401);

  const event = parsePolarEvent(rawBody, headers.id);
  if (!event) return errorResponse("invalid_event", 400);

  const admin = createAdminClient();
  if (!admin) {
    console.error("[polar] SUPABASE_SERVICE_ROLE_KEY (or the Supabase URL) is not set: the webhook cannot write");
    return errorResponse("supabase_admin_not_configured", 503);
  }

  try {
    const result = await processPolarDelivery(supabaseBillingStore(admin), event, polarContext);
    return Response.json({ ok: true, status: result.status });
  } catch (error) {
    console.error(`[polar] webhook ${event.event_type} ${event.event_id} failed:`, error);
    return errorResponse("webhook_failed", 500);
  }
}
