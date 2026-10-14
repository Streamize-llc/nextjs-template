/**
 * Polar environment. Reads `process.env` only (no `server-only`, so the tests can import it); the access token is in here, so never import it
 * from a client component. https://docs.polar.sh
 */
import type { Env } from "../types";

export type PolarServer = "sandbox" | "production";

export const POLAR_API = {
  production: "https://api.polar.sh",
  sandbox: "https://sandbox-api.polar.sh",
} as const;

/** What a mistake in the environment is called, so a route can answer 503 `billing_not_configured` instead of a 500. */
export class PolarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarConfigError";
  }
}

/** Sandbox unless `POLAR_SERVER=production`: a missing or misspelled value can only ever fail to charge, never charge for real by accident. */
export function polarServer(env: Env = process.env): PolarServer {
  return env.POLAR_SERVER === "production" ? "production" : "sandbox";
}

export interface PolarServerConfig {
  accessToken: string;
  apiBase: string;
  server: PolarServer;
  /** Needed by the webhook route only. */
  webhookSecret: string | null;
}

export function getPolarServerConfig(env: Env = process.env): PolarServerConfig {
  const accessToken = env.POLAR_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new PolarConfigError("POLAR_ACCESS_TOKEN is not set");
  const server = polarServer(env);
  return { accessToken, apiBase: POLAR_API[server], server, webhookSecret: env.POLAR_WEBHOOK_SECRET?.trim() || null };
}

/** Why the server cannot talk to Polar (checkout, portal, sync), or null when it can. Polar needs nothing in the browser. */
export function polarConfigProblem(env: Env = process.env): string | null {
  try {
    getPolarServerConfig(env);
  } catch (error) {
    if (error instanceof PolarConfigError) return error.message;
    throw error;
  }
  return null;
}

export function polarConfigured(env: Env = process.env): boolean {
  return polarConfigProblem(env) === null;
}
