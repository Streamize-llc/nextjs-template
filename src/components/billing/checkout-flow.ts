// No "use client" here on purpose: pure, so the tests can import it, and it stays free of any provider's script.

/** What POST /api/billing/checkout answers (src/lib/billing/adapter.ts `CheckoutOutcome`), or `{ error }`. */
export interface CheckoutAnswer {
  error?: string;
  provider?: string;
  transactionId?: string;
  clientToken?: string;
  environment?: string;
  url?: string;
}

/** What the browser does with the answer. The button does not know which provider is configured: the server says. */
export type CheckoutStep =
  | { action: "sign_in" }
  | { action: "error"; code: string | null }
  | { action: "redirect"; url: string }
  | { action: "paddle_overlay"; transactionId: string; clientToken: string; environment: "sandbox" | "production" };

export function nextCheckoutStep(status: number, ok: boolean, answer: CheckoutAnswer): CheckoutStep {
  if (status === 401) return { action: "sign_in" };
  if (!ok) return { action: "error", code: answer.error ?? null };
  // Polar: its own checkout page. Only a real http(s) URL: never something that runs in this page.
  if (answer.provider === "polar" && typeof answer.url === "string" && /^https:\/\//.test(answer.url)) return { action: "redirect", url: answer.url };
  if (answer.provider === "paddle" && answer.transactionId && answer.clientToken && (answer.environment === "sandbox" || answer.environment === "production")) {
    return { action: "paddle_overlay", transactionId: answer.transactionId, clientToken: answer.clientToken, environment: answer.environment };
  }
  return { action: "error", code: null };
}
