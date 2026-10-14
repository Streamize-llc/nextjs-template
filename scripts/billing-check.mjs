#!/usr/bin/env node
// Which payment provider takes NEW checkouts, and is each provider ready? No network, no changes. Run through npm (it loads .env.local):
//
//   npm run billing:check
//
// For the details of one provider run `npm run paddle:check` or `npm run polar:check`. The rules below are the ones of
// src/lib/billing/provider.ts (tests/billing-check-script.test.ts keeps the two in step).
const env = process.env;
const wanted = (env.BILLING_PROVIDER ?? "").trim().toLowerCase();

function paddleProblem() {
  const key = (env.PADDLE_API_KEY ?? "").trim();
  if (!key) return "PADDLE_API_KEY is not set";
  const production = env.NEXT_PUBLIC_PADDLE_ENVIRONMENT === "production";
  if (production && !key.startsWith("pdl_live_")) return "NEXT_PUBLIC_PADDLE_ENVIRONMENT is production but PADDLE_API_KEY is not a live key (pdl_live_...)";
  if (!production && !key.startsWith("pdl_sdbx_")) return "NEXT_PUBLIC_PADDLE_ENVIRONMENT is sandbox (the default) but PADDLE_API_KEY is not a sandbox key (pdl_sdbx_...)";
  if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test((env.PADDLE_APP_TAG ?? "").trim())) return "PADDLE_APP_TAG must be a short unique name for this app (lowercase letters, digits, - and _)";
  return null;
}
const paddleCheckoutProblem = () => paddleProblem() ?? ((env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "").trim() ? null : "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set");
const polarProblem = () => ((env.POLAR_ACCESS_TOKEN ?? "").trim() ? null : "POLAR_ACCESS_TOKEN is not set");

const providers = [
  { name: "paddle", label: "Paddle", checkout: paddleCheckoutProblem(), server: paddleProblem(), webhook: (env.PADDLE_WEBHOOK_SECRET ?? "").trim().length > 0 },
  { name: "polar", label: "Polar", checkout: polarProblem(), server: polarProblem(), webhook: (env.POLAR_WEBHOOK_SECRET ?? "").trim().length > 0 },
];

for (const provider of providers) {
  if (provider.checkout === null) console.log(`✔ ${provider.label}: ready${provider.webhook ? "" : " (no webhook secret yet: payments cannot be recorded until `npm run " + provider.name + ":webhook` has run)"}`);
  else if (provider.server === null) console.log(`• ${provider.label}: can serve its existing subscribers (portal, sync, webhooks) but cannot take a new checkout: ${provider.checkout}`);
  else console.log(`✖ ${provider.label}: not configured: ${provider.checkout}`);
}

let choice = null;
let reason = null;
if (wanted) {
  const provider = providers.find((candidate) => candidate.name === wanted);
  if (!provider) reason = `BILLING_PROVIDER must be "paddle" or "polar", not "${env.BILLING_PROVIDER}"`;
  else if (provider.checkout) reason = `BILLING_PROVIDER is ${wanted} but ${provider.checkout}`;
  else choice = wanted;
} else {
  const ready = providers.filter((provider) => provider.checkout === null);
  if (ready.length === 1) choice = ready[0].name;
  else if (ready.length === 0) reason = "no payment provider is configured (set up Paddle or Polar, see BILLING.md)";
  else reason = "both Paddle and Polar are configured: set BILLING_PROVIDER to the one that should take new checkouts";
}

console.log(choice ? `\nNew checkouts: ${choice}${wanted ? "" : " (the only one configured; set BILLING_PROVIDER to be explicit)"}` : `\nNew checkouts: none. ${reason}`);
if (choice) {
  const other = providers.find((provider) => provider.name !== choice);
  if (other.server === null) console.log(`Existing ${other.label} subscribers keep working: the ${other.label} webhook, portal and sync stay active while its keys are in .env.`);
}
process.exit(choice ? 0 : 1);
