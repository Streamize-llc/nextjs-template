import "server-only";
import { errorResponse } from "../route-helpers";
import { getPolarServerConfig, PolarConfigError, type PolarServerConfig } from "./config";

/** The Polar configuration, or the 503 to answer with when it is incomplete (`billing_not_configured`, with the reason in the server log). */
export function polarConfigOrResponse(): { config: PolarServerConfig } | { response: Response } {
  try {
    return { config: getPolarServerConfig() };
  } catch (error) {
    if (!(error instanceof PolarConfigError)) throw error;
    console.error(`[polar] ${error.message}`);
    return { response: errorResponse("billing_not_configured", 503) };
  }
}
