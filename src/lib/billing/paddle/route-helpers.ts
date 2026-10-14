import "server-only";
import { errorResponse } from "../route-helpers";
import { getPaddleServerConfig, PaddleConfigError, type PaddleServerConfig } from "./config";

/** The Paddle configuration, or the 503 to answer with when it is incomplete (`billing_not_configured`, with the reason in the server log). */
export function paddleConfigOrResponse(): { config: PaddleServerConfig } | { response: Response } {
  try {
    return { config: getPaddleServerConfig() };
  } catch (error) {
    if (!(error instanceof PaddleConfigError)) throw error;
    console.error(`[paddle] ${error.message}`);
    return { response: errorResponse("billing_not_configured", 503) };
  }
}
