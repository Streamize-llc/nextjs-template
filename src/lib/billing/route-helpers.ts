import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import type { AdapterUser } from "./adapter";

/** Error answers carry a stable code, never display text: the UI decides what to say (src/components/billing/messages.ts). */
export function errorResponse(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
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

/** What an adapter needs to know about the user. `email_confirmed_at` is set by Supabase once the address was confirmed (always for OAuth sign-ins). */
export function adapterUser(user: User): AdapterUser {
  return { id: user.id, email: user.email ?? null, emailVerified: Boolean(user.email_confirmed_at) };
}
