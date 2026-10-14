/**
 * What to tell the user for each error code the /api/billing routes answer with. English; replace it (or route it through your i18n) when
 * you localise the app. An unknown code falls back to the generic text.
 */
const MESSAGES: Record<string, string> = {
  unauthorized: "Please sign in first.",
  already_subscribed: "You already have a subscription. Use “Manage billing” to change or cancel it.",
  email_required: "Your account has no e-mail address, which payment needs.",
  email_not_verified: "Please confirm your e-mail address first (check your inbox), then try again.",
  customer_conflict: "This e-mail is already linked to another account. Please contact support.",
  price_not_configured: "This plan is not available yet.",
  unknown_item: "This plan does not exist.",
  billing_not_configured: "Payments are not set up yet.",
  too_many_requests: "Please wait a moment and try again.",
  no_customer: "There is nothing to manage yet: you have not bought anything.",
  paddle_js_failed: "The payment window could not be loaded. Check your connection or any blocker, then try again.",
};

export const GENERIC_BILLING_ERROR = "Something went wrong with the payment. Please try again, and contact support if it keeps happening.";

export function billingErrorMessage(code: string | undefined | null): string {
  return (code && MESSAGES[code]) || GENERIC_BILLING_ERROR;
}
