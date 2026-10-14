/**
 * Paddle environment. Reads `process.env` only (no `server-only`, so the tests can import it); never import it from a client component, the
 * API key is in here. The browser gets its token through `paddleClientConfig()`. Which of OUR items a price id is lives in ../catalog.ts.
 */
import type { Env } from "../types";

export type PaddleEnvironment = "sandbox" | "production";

export const PADDLE_API = {
  production: "https://api.paddle.com",
  sandbox: "https://sandbox-api.paddle.com",
  version: "1",
} as const;

/** What a mistake in the environment is called, so a route can answer 503 `billing_not_configured` instead of a 500. */
export class PaddleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaddleConfigError";
  }
}

export function paddleEnvironment(env: Env = process.env): PaddleEnvironment {
  return env.NEXT_PUBLIC_PADDLE_ENVIRONMENT === "production" ? "production" : "sandbox";
}

const APP_TAG = /^[a-z0-9][a-z0-9_-]{1,40}$/;

export interface PaddleServerConfig {
  apiKey: string;
  apiBase: string;
  environment: PaddleEnvironment;
  /** Unique per app on a shared Paddle account: stamped on everything this app creates and checked on everything it receives. */
  appTag: string;
  /** Needed by the webhook route only. */
  webhookSecret: string | null;
}

/**
 * The server-side configuration, or a PaddleConfigError saying what is missing. Three mistakes are refused on purpose, because each one
 * silently charges (or fails to charge) the wrong account: a sandbox key in a production environment (and the reverse), and a missing app tag.
 */
export function getPaddleServerConfig(env: Env = process.env): PaddleServerConfig {
  const apiKey = env.PADDLE_API_KEY?.trim();
  if (!apiKey) throw new PaddleConfigError("PADDLE_API_KEY is not set");
  const environment = paddleEnvironment(env);
  if (environment === "production" && !apiKey.startsWith("pdl_live_")) {
    throw new PaddleConfigError("NEXT_PUBLIC_PADDLE_ENVIRONMENT is production but PADDLE_API_KEY is not a live key (pdl_live_...)");
  }
  if (environment === "sandbox" && !apiKey.startsWith("pdl_sdbx_")) {
    throw new PaddleConfigError("NEXT_PUBLIC_PADDLE_ENVIRONMENT is sandbox (the default) but PADDLE_API_KEY is not a sandbox key (pdl_sdbx_...)");
  }
  const appTag = env.PADDLE_APP_TAG?.trim() ?? "";
  if (!APP_TAG.test(appTag)) {
    throw new PaddleConfigError("PADDLE_APP_TAG must be set to a short unique name for this app (lowercase letters, digits, - and _), e.g. my-app");
  }
  return {
    apiKey,
    apiBase: PADDLE_API[environment],
    environment,
    appTag,
    webhookSecret: env.PADDLE_WEBHOOK_SECRET?.trim() || null,
  };
}

/** Why the server cannot talk to Paddle (portal, sync, webhook), or null: the key, the app tag are there and consistent. */
export function paddleServerProblem(env: Env = process.env): string | null {
  try {
    getPaddleServerConfig(env);
  } catch (error) {
    if (error instanceof PaddleConfigError) return error.message;
    throw error;
  }
  return null;
}

/** Why Paddle cannot take a CHECKOUT (a sentence for the server log), or null when it can: the server side above plus the browser token. */
export function paddleConfigProblem(env: Env = process.env): string | null {
  return paddleServerProblem(env) ?? (env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN?.trim() ? null : "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set");
}

export function paddleConfigured(env: Env = process.env): boolean {
  return paddleConfigProblem(env) === null;
}

/** The token Paddle.js needs in the browser. Public by design (`test_...` / `live_...`). */
export function paddleClientConfig(env: Env = process.env): { token: string | null; environment: PaddleEnvironment } {
  return { token: env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN?.trim() || null, environment: paddleEnvironment(env) };
}
