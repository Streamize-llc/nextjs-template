/**
 * Server-side configuration
 * Server-only settings (never exposed to browser)
 *
 * Note: Supabase credentials are managed via environment variables directly
 */

import { clientConfig } from './client';

export const serverConfig = {
  ...clientConfig,

  // Add server-only configurations here
  // Example:
  // api: {
  //   baseUrl: 'https://api.example.com',
  // },
} as const;
