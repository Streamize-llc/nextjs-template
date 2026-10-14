import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client with the SERVICE ROLE key: it bypasses Row Level Security. Server only (the `server-only` import fails the build if a
 * client component ever imports this). Use it for what no signed-in user may do themselves: the Paddle and Polar webhooks, and the billing routes
 * that write `billing_*` rows. Returns null when the environment is not configured, like the other Supabase helpers.
 */
export function createAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
