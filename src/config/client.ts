/**
 * Client-side configuration
 * Non-sensitive settings that can be exposed to the browser
 *
 * Note: Supabase credentials are managed via environment variables directly
 */

export const clientConfig = {
  app: {
    name: 'My App',
    // Add non-sensitive client settings here
  },
  analytics: {
    gaId: process.env.NEXT_PUBLIC_GAID!,
  },
} as const;
