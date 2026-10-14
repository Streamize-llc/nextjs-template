#!/usr/bin/env node
// One-time Polar setup, driven by src/config/billing.ts. Run through npm (they load .env.local):
//
//   npm run polar:check                        what is configured and what is still missing; when the token can read products, also whether each
//                                              product matches the catalog (interval, price, currency)
//   npm run polar:catalog                      print the products to create in the Polar dashboard, and the POLAR_PRODUCT_* lines to fill in
//   npm run polar:webhook -- https://<your domain>/api/webhooks/polar [--write]
//                                              register the webhook endpoint (it needs a PUBLIC url: your deployed site, or a tunnel) and, with
//                                              --write, put its signing secret into .env.local
//   node --env-file=.env.local scripts/polar-setup.mjs webhook-list | webhook-delete <id>
//
// Why the catalog is a checklist and not an API call: Polar products are made in the dashboard (a couple of minutes for a handful), and the
// check afterwards compares each one with src/config/billing.ts, which is what a merchant of record's review does too.
// The access token needs: checkouts:write, customer_sessions:write, subscriptions:read, orders:read. This script additionally uses
// products:read (check) and webhooks:read + webhooks:write (webhook-*): add those scopes for the setup and take them off again.
// POLAR_SERVER=sandbox (the default) talks to sandbox.polar.sh, a separate account and data set from production. `webhook-create` against
// production needs --live --yes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
const [command, argument] = argv.filter((arg) => !arg.startsWith("--"));

const TOKEN = (process.env.POLAR_ACCESS_TOKEN ?? "").trim();
const SERVER = process.env.POLAR_SERVER === "production" ? "production" : "sandbox";
const BASE = SERVER === "production" ? "https://api.polar.sh" : "https://sandbox-api.polar.sh";
/** Where `--write` puts what it creates. `--out=<file>` lets a LIVE run write into its own file instead of .env.local. */
const ENV_FILE = argv.find((arg) => arg.startsWith("--out="))?.slice(6) ?? ".env.local";

// The events src/lib/billing/polar/webhook.ts handles (tests/polar-webhook.test.ts keeps the two lists equal).
const EVENTS = [
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "subscription.past_due",
  "order.paid",
  "order.updated",
  "order.refunded",
];

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const { billingConfig, catalogItems, productEnvName, toMinorUnits, validateBillingConfig } = await import("../src/config/billing.ts");
const { productProblems } = await import("../src/lib/billing/polar/product-check.ts");

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: response.status, ok: response.ok, json };
}

// ── check ────────────────────────────────────────────────────────────────────────────────────────────
async function check() {
  const problems = validateBillingConfig();
  const rows = [];
  const row = (name, ok, hint) => rows.push({ name, ok, hint });
  row("src/config/billing.ts is valid", problems.length === 0, problems.join("; "));
  row("POLAR_ACCESS_TOKEN", TOKEN.length > 0, "an organization access token: Polar > Settings > Developers (sandbox.polar.sh for the sandbox)");
  row("POLAR_WEBHOOK_SECRET", (process.env.POLAR_WEBHOOK_SECRET ?? "").trim().length > 0, "the signing secret of the webhook endpoint: run `npm run polar:webhook -- <url> --write`, or copy it from the dashboard");
  row("POLAR_SERVER", ["sandbox", "production"].includes(process.env.POLAR_SERVER ?? "sandbox"), 'sandbox (the default) or production; anything else counts as sandbox');
  row("SUPABASE_SERVICE_ROLE_KEY", Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY), "Supabase > Project settings > API > service_role (server only)");
  const items = catalogItems();
  for (const item of items) {
    const name = productEnvName(item);
    row(name, Boolean(process.env[name]?.trim()), "create the product in the Polar dashboard (`npm run polar:catalog` lists them) and paste its id");
  }

  // Online: does each configured product match the catalog? Skipped (not failed) when the token cannot read products.
  const notes = [];
  if (TOKEN && !flags.has("--offline")) {
    for (const item of items) {
      const id = process.env[productEnvName(item)]?.trim();
      if (!id) continue;
      const answer = await api(`/v1/products/${encodeURIComponent(id)}`);
      const label = `${productEnvName(item)} matches the catalog`;
      if (answer.status === 403) {
        notes.push("the token cannot read products (scope products:read): the products were not compared with the catalog");
        break;
      }
      if (answer.status === 404 || answer.status === 422) {
        row(label, false, `Polar has no product ${id} on the ${SERVER} server (wrong POLAR_SERVER or a product of another organization?)`);
        continue;
      }
      if (!answer.ok) {
        row(label, false, `Polar answered ${answer.status} for the product`);
        continue;
      }
      const mismatch = productProblems(answer.json, { interval: item.interval, amountMinor: Number(toMinorUnits(item.amount)), currency: billingConfig.currency });
      row(label, mismatch.length === 0, mismatch.join("; "));
    }
  }

  for (const { name, ok, hint } of rows) console.log(`${ok ? "✔" : "✖"} ${name}${ok ? "" : `  <- ${hint}`}`);
  for (const note of [...new Set(notes)]) console.log(`• ${note}`);
  const provider = (process.env.BILLING_PROVIDER ?? "").trim().toLowerCase();
  if (provider && provider !== "polar") console.log(`• BILLING_PROVIDER is "${provider}": new checkouts do NOT go to Polar. Polar stays active for the subscribers it already has.`);
  const missing = rows.filter((r) => !r.ok).length;
  console.log(missing === 0 ? "\nReady." : `\n${missing} thing(s) to do. See BILLING.md.`);
  process.exit(missing === 0 ? 0 : 1);
}

if (command === "check") await check();

// ── catalog: a checklist, no network ─────────────────────────────────────────────────────────────────
if (command === "catalog") {
  const problems = validateBillingConfig();
  if (problems.length > 0) fail(`src/config/billing.ts has problems:\n- ${problems.join("\n- ")}`);
  console.log(`Create these products in the Polar dashboard (${SERVER === "production" ? "PRODUCTION" : "sandbox: https://sandbox.polar.sh"}), one each, then paste the ids:\n`);
  for (const item of catalogItems()) {
    const price = `${item.amount.toFixed(2)} ${billingConfig.currency}`;
    console.log(`  ${item.name}${item.interval ? ` (${item.interval === "month" ? "monthly" : "yearly"})` : ""}`);
    console.log(`    type: ${item.interval ? `recurring, every 1 ${item.interval}` : "one-time"}   price: fixed ${price}`);
    console.log(`    description: ${item.description}`);
    console.log(`    -> ${productEnvName(item)}=<the product id>\n`);
  }
  console.log("Then run `npm run polar:check`: it compares every product with src/config/billing.ts.");
  process.exit(0);
}

// ── everything below talks to Polar's webhook API ────────────────────────────────────────────────────
if (!["webhook-create", "webhook-list", "webhook-delete"].includes(command ?? "")) {
  fail("usage: check [--offline] | catalog | webhook-create <url> [--write] [--out=<file>] | webhook-list | webhook-delete <id>");
}
if (!TOKEN) fail("POLAR_ACCESS_TOKEN is not set (run through npm, which loads .env.local).");
if (SERVER === "production" && command !== "webhook-list" && !(flags.has("--live") && flags.has("--yes"))) {
  fail(`refusing: POLAR_SERVER is production. Add --live --yes to ${command} if you mean it (it registers or removes a webhook endpoint of your LIVE organization).`);
}

/** Merge KEY=value lines into the env file, replacing a line of the same name and keeping the rest. */
function writeEnv(entries) {
  for (const [name, value] of Object.entries(entries)) {
    if (typeof value !== "string" || value.length === 0 || value === "undefined") fail(`refusing to write ${name}=${String(value)} into ${ENV_FILE}`);
  }
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n").filter((line) => line.length > 0) : [];
  const names = new Set(Object.keys(entries));
  const kept = lines.filter((line) => !names.has(line.split("=")[0]));
  for (const [name, value] of Object.entries(entries)) kept.push(`${name}=${value}`);
  writeFileSync(ENV_FILE, `${kept.join("\n")}\n`);
}

if (command === "webhook-create") {
  const url = argument;
  if (!url || !/^https:\/\/[^/\s]+\/api\/webhooks\/polar$/.test(url)) fail("usage: webhook-create https://<your domain>/api/webhooks/polar  (a public https URL; use a tunnel for local development)");
  // Polar IGNORES a secret we send and generates its own, so `secret` here only has to be long enough to be accepted: the real one is read back.
  const created = await api("/v1/webhooks/endpoints", "POST", { url, format: "raw", secret: "x".repeat(32), events: EVENTS });
  if (!created.ok) fail(`create failed: ${created.status} ${JSON.stringify(created.json).slice(0, 400)}`);
  console.log(`created webhook endpoint ${created.json.id} -> ${url} (${EVENTS.length} events, format raw)`);
  const real = await api(`/v1/webhooks/endpoints/${created.json.id}`);
  const secret = real.json?.secret;
  if (typeof secret !== "string" || secret.length < 16) {
    fail(`Polar did not return a signing secret for ${created.json.id}. Open it in the Polar dashboard (Settings > Webhooks) and copy the secret into POLAR_WEBHOOK_SECRET.`);
  }
  if (flags.has("--write")) {
    writeEnv({ POLAR_WEBHOOK_SECRET: secret });
    console.log(`wrote POLAR_WEBHOOK_SECRET to ${ENV_FILE}`);
  } else {
    console.log("\nIts signing secret (keep it private) - set it as POLAR_WEBHOOK_SECRET:");
    console.log(`POLAR_WEBHOOK_SECRET=${secret}`);
  }
} else if (command === "webhook-list") {
  const listed = await api("/v1/webhooks/endpoints?limit=100");
  if (!listed.ok) fail(`list failed: ${listed.status} ${JSON.stringify(listed.json).slice(0, 300)}`);
  for (const item of listed.json.items ?? []) console.log(`${item.id}  ${item.enabled ? "enabled " : "disabled"}  ${item.url}  (${item.events?.length ?? 0} events)`);
  if (!(listed.json.items ?? []).length) console.log("no endpoints");
} else if (command === "webhook-delete") {
  if (!argument) fail("usage: webhook-delete <endpoint id>");
  const deleted = await api(`/v1/webhooks/endpoints/${encodeURIComponent(argument)}`, "DELETE");
  console.log(deleted.status === 204 ? `deleted ${argument}` : `not deleted (${deleted.status})`);
}
