#!/usr/bin/env node
// One-time Paddle setup, driven by src/config/billing.ts. Run through npm (they load .env.local):
//
//   npm run paddle:check                       what is configured and what is still missing (no changes anywhere)
//   npm run paddle:catalog                     create a product per plan / product and a price per interval in Paddle, print the PADDLE_PRICE_* lines
//   npm run paddle:catalog -- --write          ...and put them into .env.local
//   npm run paddle:webhook -- https://<your domain>/api/webhooks/paddle [--write] [--inactive]
//                                              create the notification destination (it needs a PUBLIC url: your deployed site, or an ngrok tunnel)
//   node --env-file=.env.local scripts/paddle-setup.mjs webhook-activate <id> | webhook-list | webhook-delete <id>
//
// Safe to run again: a product or price that already exists (found by the PADDLE_APP_TAG stamped on it) is reused, never duplicated, and
// nothing is ever deleted except by `webhook-delete`. The sandbox needs nothing special. On the LIVE account (a `pdl_live_` key with
// NEXT_PUBLIC_PADDLE_ENVIRONMENT=production) every command that changes something (`catalog`, `webhook-create`, `webhook-activate`,
// `webhook-delete`) additionally requires `--live --yes`, and `webhook-create` creates the destination INACTIVE (activate it after the deploy
// with `webhook-activate`), so nothing is sent to a site that is not up yet. Keep the live key in its own file, never in .env.local:
//   node --no-warnings --env-file=.env.production.local scripts/paddle-setup.mjs catalog --live --yes --write --out=.env.production.local
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
const [command, argument] = argv.filter((arg) => !arg.startsWith("--"));

const KEY = (process.env.PADDLE_API_KEY ?? "").trim();
const ENVIRONMENT = process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT === "production" ? "production" : "sandbox";
const TAG = (process.env.PADDLE_APP_TAG ?? "").trim();
/** Where `--write` puts what it creates. `--out=<file>` lets a LIVE run write into its own file instead of .env.local. */
const ENV_FILE = argv.find((arg) => arg.startsWith("--out="))?.slice(6) ?? ".env.local";

const EVENTS = [
  "transaction.completed",
  "adjustment.created",
  "adjustment.updated",
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.canceled",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
];

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const { billingConfig, catalogItems, priceEnvName, toMinorUnits, validateBillingConfig } = await import("../src/config/billing.ts");

// ── check: no network, no changes ────────────────────────────────────────────────────────────────────
function check() {
  const problems = validateBillingConfig();
  const rows = [];
  const row = (name, ok, hint) => rows.push({ name, ok, hint });
  row("src/config/billing.ts is valid", problems.length === 0, problems.join("; "));
  row("PADDLE_APP_TAG", /^[a-z0-9][a-z0-9_-]{1,40}$/.test(TAG), "a short unique name for THIS app, e.g. my-app (lowercase, digits, - _)");
  const keyOk = ENVIRONMENT === "production" ? KEY.startsWith("pdl_live_") : KEY.startsWith("pdl_sdbx_");
  row(`PADDLE_API_KEY (${ENVIRONMENT})`, keyOk, ENVIRONMENT === "production" ? "a live key (pdl_live_...) is needed when NEXT_PUBLIC_PADDLE_ENVIRONMENT=production" : "a sandbox key (pdl_sdbx_...); Paddle sandbox > Developer tools > Authentication");
  const token = (process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "").trim();
  row("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", ENVIRONMENT === "production" ? token.startsWith("live_") : token.startsWith("test_"), "a client-side token (test_... in the sandbox, live_... live); Developer tools > Authentication");
  row("PADDLE_WEBHOOK_SECRET", (process.env.PADDLE_WEBHOOK_SECRET ?? "").startsWith("pdl_ntfset_"), "a notification destination's secret key (pdl_ntfset_...): run `npm run paddle:webhook -- <url> --write`, or copy it from the dashboard");
  row("SUPABASE_SERVICE_ROLE_KEY", Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY), "Supabase > Project settings > API > service_role (server only)");
  for (const item of catalogItems()) {
    const name = priceEnvName(item);
    row(name, Boolean(process.env[name]?.trim()), "run `npm run paddle:catalog -- --write`");
  }
  for (const { name, ok, hint } of rows) console.log(`${ok ? "✔" : "✖"} ${name}${ok ? "" : `  <- ${hint}`}`);
  const missing = rows.filter((r) => !r.ok).length;
  console.log(missing === 0 ? "\nReady." : `\n${missing} thing(s) to do. See PADDLE.md.`);
  process.exit(missing === 0 ? 0 : 1);
}

if (command === "check") check();

// ── everything below talks to Paddle ─────────────────────────────────────────────────────────────────
if (!command || !["catalog", "webhook-create", "webhook-activate", "webhook-list", "webhook-delete"].includes(command)) {
  fail("usage: check | catalog [--write] | webhook-create <url> [--write] [--inactive] | webhook-activate <id> | webhook-list | webhook-delete <id>");
}
if (!KEY) fail("PADDLE_API_KEY is not set (run through npm, which loads .env.local).");
const live = KEY.startsWith("pdl_live_");
if (!live && !KEY.startsWith("pdl_sdbx_")) fail("PADDLE_API_KEY is neither a sandbox (pdl_sdbx_...) nor a live (pdl_live_...) key.");
if (live !== (ENVIRONMENT === "production")) {
  fail(`refusing: the key is ${live ? "LIVE" : "sandbox"} but NEXT_PUBLIC_PADDLE_ENVIRONMENT is ${ENVIRONMENT}. They must agree.`);
}
if (live && ["catalog", "webhook-create", "webhook-activate", "webhook-delete"].includes(command) && !(flags.has("--live") && flags.has("--yes"))) {
  fail(`refusing: this is the LIVE Paddle account. Add --live --yes to ${command} if you mean it (nothing is charged: it creates or changes products, prices and notification destinations).`);
}
if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(TAG) && ["catalog", "webhook-create"].includes(command)) {
  fail("PADDLE_APP_TAG must be set to a short unique name for this app (lowercase letters, digits, - and _).");
}

const BASE = live ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Paddle-Version": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = json.error ? `${json.error.code}: ${json.error.detail}` : response.statusText;
    const fields = json.error?.errors ? ` ${JSON.stringify(json.error.errors)}` : "";
    throw new Error(`${method} ${path} -> ${response.status} ${detail}${fields}`);
  }
  return json;
}

async function list(path) {
  const out = [];
  let next = `${path}${path.includes("?") ? "&" : "?"}per_page=200`;
  while (next) {
    const page = await api(next);
    out.push(...page.data);
    const url = page.meta?.pagination?.has_more ? page.meta.pagination.next : null;
    next = url ? url.replace(BASE, "") : null;
  }
  return out;
}

/** Merge KEY=value lines into .env.local, replacing a line of the same name and keeping the rest. */
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

if (command === "catalog") {
  const problems = validateBillingConfig();
  if (problems.length > 0) fail(`src/config/billing.ts has problems:\n- ${problems.join("\n- ")}`);
  const tax = argv.find((arg) => arg.startsWith("--tax="))?.slice(6) ?? "standard";
  const currency = billingConfig.currency;

  const products = await list("/products?status=active");
  const prices = await list("/prices?status=active");
  const entries = {};
  const productFor = new Map();

  for (const item of catalogItems()) {
    const productKey = `${item.kind}:${item.key}`;
    let product = productFor.get(productKey) ?? products.find((p) => p.custom_data?.app === TAG && p.custom_data?.kind === item.kind && p.custom_data?.key === item.key);
    if (!product) {
      product = (await api("/products", "POST", { name: item.name, description: item.description, tax_category: tax, custom_data: { app: TAG, kind: item.kind, key: item.key } })).data;
      console.log(`created product ${item.name} (${product.id})`);
    }
    productFor.set(productKey, product);

    const amount = toMinorUnits(item.amount);
    let price = prices.find(
      (p) =>
        p.product_id === product.id &&
        p.unit_price.amount === amount &&
        p.unit_price.currency_code === currency &&
        (item.interval ? p.billing_cycle?.interval === item.interval && p.billing_cycle?.frequency === 1 : !p.billing_cycle),
    );
    if (!price) {
      price = (
        await api("/prices", "POST", {
          product_id: product.id,
          description: item.interval ? `${item.name} (${item.interval === "month" ? "monthly" : "yearly"})` : item.name,
          unit_price: { amount, currency_code: currency },
          tax_mode: "account_setting",
          quantity: { minimum: 1, maximum: 1 },
          custom_data: { app: TAG, kind: item.kind, key: item.key, interval: item.interval },
          ...(item.interval ? { billing_cycle: { interval: item.interval, frequency: 1 } } : {}),
        })
      ).data;
      console.log(`created price ${item.name} ${item.interval ?? "one-time"} ${item.amount} ${currency} (${price.id})`);
    }
    entries[priceEnvName(item)] = price.id;
  }

  console.log("\n# Paddle price ids (not secret):");
  for (const [name, value] of Object.entries(entries)) console.log(`${name}=${value}`);
  if (flags.has("--write")) {
    writeEnv(entries);
    console.log(`\nwrote ${Object.keys(entries).length} line(s) to ${ENV_FILE}`);
  } else {
    console.log(`\nAdd them to ${ENV_FILE} (or run again with --write).`);
  }
} else if (command === "webhook-create") {
  const url = argument;
  if (!url || !/^https:\/\/[^/\s]+\/api\/webhooks\/paddle$/.test(url)) fail("usage: webhook-create https://<your domain>/api/webhooks/paddle  (a public https URL; use an ngrok tunnel for local development)");
  const active = !(flags.has("--inactive") || live);
  const created = (
    await api("/notification-settings", "POST", {
      description: `${TAG} webhook`,
      destination: url,
      type: "url",
      active,
      include_sensitive_fields: false,
      subscribed_events: EVENTS,
    })
  ).data;
  console.log(`created notification destination ${created.id} -> ${url} (${active ? "active" : "INACTIVE: run webhook-activate " + created.id + " after the deploy"})`);
  // Paddle names the signing secret `endpoint_secret_key`. Never write anything else into .env.local: a secret of "undefined" verifies nothing.
  const secret = created.endpoint_secret_key;
  if (typeof secret !== "string" || !secret.startsWith("pdl_ntfset_")) {
    fail(`Paddle did not return a signing secret for ${created.id}. Open it in the Paddle dashboard (Developer tools > Notifications) and copy the secret key into PADDLE_WEBHOOK_SECRET.`);
  }
  if (flags.has("--write")) {
    writeEnv({ PADDLE_WEBHOOK_SECRET: secret });
    console.log(`wrote PADDLE_WEBHOOK_SECRET to ${ENV_FILE}`);
  } else {
    console.log("\nIts signing secret (keep it private) - set it as PADDLE_WEBHOOK_SECRET:");
    console.log(`PADDLE_WEBHOOK_SECRET=${secret}`);
  }
} else if (command === "webhook-activate") {
  if (!argument) fail("usage: webhook-activate <notification setting id>");
  await api(`/notification-settings/${encodeURIComponent(argument)}`, "PATCH", { active: true });
  console.log(`activated ${argument}`);
} else if (command === "webhook-list") {
  for (const setting of (await api("/notification-settings")).data) {
    console.log(`${setting.id}  ${setting.active ? "active  " : "inactive"}  ${setting.destination}  (${setting.subscribed_events?.length ?? 0} events)`);
  }
} else if (command === "webhook-delete") {
  if (!argument) fail("usage: webhook-delete <notification setting id>");
  await api(`/notification-settings/${encodeURIComponent(argument)}`, "DELETE");
  console.log(`deleted ${argument}`);
}
