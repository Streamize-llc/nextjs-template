import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import { getPaddleServerConfig, itemForPriceId, PaddleConfigError, type PaddleServerConfig } from "./config";
import type { WebhookContext } from "./webhook";

/** Error answers carry a stable code, never display text: the UI decides what to say (src/components/billing/messages.ts). */
export function errorResponse(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

/** The Paddle configuration, or the 503 to answer with when it is incomplete (`paddle_not_configured`, with the reason in the server log). */
export function paddleConfigOrResponse(): { config: PaddleServerConfig } | { response: Response } {
  try {
    return { config: getPaddleServerConfig() };
  } catch (error) {
    if (!(error instanceof PaddleConfigError)) throw error;
    console.error(`[paddle] ${error.message}`);
    return { response: errorResponse("paddle_not_configured", 503) };
  }
}

/** The signed-in user (from the session cookie) and a Supabase client that carries their session, or the response to send back. */
export async function userOrResponse(): Promise<{ user: User; supabase: SupabaseClient } | { response: Response }> {
  // getUser() asks Supabase to validate the session; getSession() would trust the cookie.
  const supabase = await createClient();
  if (!supabase) return { response: errorResponse("supabase_not_configured", 503) };
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { response: errorResponse("unauthorized", 401) };
  return { user: data.user, supabase };
}

export function webhookContext(config: PaddleServerConfig): WebhookContext {
  return { appTag: config.appTag, itemForPriceId: (priceId) => itemForPriceId(priceId) };
}
