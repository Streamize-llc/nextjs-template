// The four route handlers, called for real with a fake Supabase (an in-memory database, a user session that tests switch on and off) and a fake Paddle API.
// Needs `--experimental-test-module-mocks` (the `test` script has it).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { signPaddleBody } from "@/lib/paddle/signature";
import { billingDb } from "./support/fake-supabase";
import { adjustmentData, CUSTOMER_ID, event, subscriptionData, transactionData, USER_ID } from "./support/paddle-fixtures";

const src = (path: string) => new URL(`../src/${path}`, import.meta.url).href;

// `mock.module` is in Node 22.3+ but not in the @types/node this project pins.
const mockModule = (mock as unknown as { module: (specifier: string, options: { namedExports: Record<string, unknown> }) => void }).module.bind(mock);

let db = billingDb();
type TestUser = { id: string; email: string | null; email_confirmed_at: string | null };
let user: TestUser | null = null;
const verified = (id: string, email: string | null): TestUser => ({ id, email, email_confirmed_at: "2026-01-01T00:00:00Z" });
let adminAvailable = true;

mockModule(src("utils/supabase/server.ts"), {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user }, error: user ? null : { message: "no session" } }) },
      from: (table: string) => db.from(table),
    }),
  },
});
mockModule(src("utils/supabase/admin.ts"), { namedExports: { createAdminClient: () => (adminAvailable ? db : null) } });

const webhook = await import("@/app/api/webhooks/paddle/route");
const checkout = await import("@/app/api/billing/checkout/route");
const portal = await import("@/app/api/billing/portal/route");
const sync = await import("@/app/api/billing/sync/route");

const SECRET = "pdl_ntfset_test";
const ENV_KEYS = ["PADDLE_API_KEY", "PADDLE_APP_TAG", "PADDLE_WEBHOOK_SECRET", "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", "NEXT_PUBLIC_PADDLE_ENVIRONMENT", "PADDLE_PRICE_PRO_MONTH", "PADDLE_PRICE_PRO_YEAR"];
const realFetch = globalThis.fetch;
const paddleCalls: { method: string; path: string; body: unknown }[] = [];
let paddleAnswers: Record<string, () => Response> = {};

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    PADDLE_API_KEY: "pdl_sdbx_apikey_test",
    PADDLE_APP_TAG: "test-app",
    PADDLE_WEBHOOK_SECRET: SECRET,
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_clienttoken",
    PADDLE_PRICE_PRO_MONTH: "pri_pro_month",
    PADDLE_PRICE_PRO_YEAR: "pri_pro_year",
  });
  db = billingDb();
  user = null;
  adminAvailable = true;
  paddleCalls.length = 0;
  paddleAnswers = {};
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? "GET";
    paddleCalls.push({ method, path: `${parsed.pathname}${parsed.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(paddleAnswers).find((candidate) => `${method} ${parsed.pathname}`.startsWith(candidate));
    if (!key) throw new Error(`unexpected Paddle call ${method} ${parsed.pathname}`);
    return paddleAnswers[key]();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const signed = (body: string) => post("/api/webhooks/paddle", body, { "paddle-signature": signPaddleBody(SECRET, body) });
const signedEvent = (type: string, data: unknown, occurredAt?: string, id?: string) => signed(JSON.stringify(event(type, data, occurredAt, id)));

describe("POST /api/webhooks/paddle", () => {
  it("answers 503 while Paddle is not configured, and never accepts anything without a webhook secret", async () => {
    delete process.env.PADDLE_API_KEY;
    assert.equal((await webhook.POST(post("/api/webhooks/paddle", "{}"))).status, 503);
    process.env.PADDLE_API_KEY = "pdl_sdbx_apikey_test";
    delete process.env.PADDLE_WEBHOOK_SECRET;
    const response = await webhook.POST(post("/api/webhooks/paddle", "{}", { "paddle-signature": signPaddleBody("", "{}") }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "webhook_secret_not_configured" });
  });

  it("refuses an unsigned, wrongly signed or tampered request with 401, and writes nothing", async () => {
    const body = JSON.stringify(event("subscription.created", subscriptionData()));
    assert.equal((await webhook.POST(post("/api/webhooks/paddle", body))).status, 401);
    assert.equal((await webhook.POST(post("/api/webhooks/paddle", body, { "paddle-signature": signPaddleBody("wrong", body) }))).status, 401);
    assert.equal((await webhook.POST(post("/api/webhooks/paddle", `${body} `, { "paddle-signature": signPaddleBody(SECRET, body) }))).status, 401);
    assert.equal(db.tables.billing_webhook_events.length, 0);
  });

  it("answers 400 for a signed body that is not an event", async () => {
    assert.equal((await webhook.POST(signed("not json"))).status, 400);
    assert.equal((await webhook.POST(signed(JSON.stringify({ hello: "world" })))).status, 400);
  });

  it("answers 503 when it cannot write (no service role key), so that Paddle tries again", async () => {
    adminAvailable = false;
    assert.equal((await webhook.POST(signedEvent("subscription.created", subscriptionData()))).status, 503);
  });

  it("applies a signed subscription event of a known customer, and a redelivery changes nothing", async () => {
    db.tables.billing_customers.push({ user_id: USER_ID, paddle_customer_id: CUSTOMER_ID });
    const first = await webhook.POST(signedEvent("subscription.created", subscriptionData(), "2026-10-14T00:00:10Z", "evt_route_1"));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, status: "processed" });
    assert.equal(db.tables.billing_subscriptions.length, 1);
    assert.equal(db.tables.billing_subscriptions[0].user_id, USER_ID);
    assert.equal(db.tables.billing_subscriptions[0].plan_key, "pro");

    db.tables.billing_subscriptions[0].status = "changed-by-test";
    const again = await webhook.POST(signedEvent("subscription.created", subscriptionData(), "2026-10-14T00:00:10Z", "evt_route_1"));
    assert.deepEqual(await again.json(), { ok: true, status: "duplicate" });
    assert.equal(db.tables.billing_subscriptions[0].status, "changed-by-test", "the duplicate was not applied");
    assert.equal(db.tables.billing_webhook_events.length, 1);
  });

  it("answers 200 and records `ignored` for a customer it does not know (never a retry storm)", async () => {
    const response = await webhook.POST(signedEvent("subscription.created", subscriptionData({ customer_id: "ctm_01stranger" }), "2026-10-14T00:00:10Z", "evt_stranger"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status: "ignored" });
    assert.equal(db.tables.billing_webhook_events[0].status, "ignored");
    assert.equal(db.tables.billing_subscriptions.length, 0);
  });

  it("records a payment and then its refund", async () => {
    db.tables.billing_customers.push({ user_id: USER_ID, paddle_customer_id: CUSTOMER_ID });
    assert.equal((await webhook.POST(signedEvent("transaction.completed", transactionData()))).status, 200);
    assert.equal((await webhook.POST(signedEvent("adjustment.created", adjustmentData({ totals: { total: "500" } })))).status, 200);
    assert.equal(db.tables.billing_transactions[0].total, 990);
    assert.equal(db.tables.billing_transactions[0].refunded, 500);
  });

  it("answers 500 when applying fails, and processes the redelivery", async () => {
    db.tables.billing_customers.push({ user_id: USER_ID, paddle_customer_id: CUSTOMER_ID });
    const original = db.from.bind(db);
    let broken = true;
    db.from = ((table: string) => {
      if (table === "billing_subscriptions" && broken) throw new Error("database is down");
      return original(table);
    }) as typeof db.from;
    const request = () => signedEvent("subscription.created", subscriptionData(), "2026-10-14T00:00:10Z", "evt_flaky");
    assert.equal((await webhook.POST(request())).status, 500);
    assert.equal(db.tables.billing_webhook_events[0].status, "failed");
    broken = false;
    assert.equal((await webhook.POST(request())).status, 200);
    assert.equal(db.tables.billing_subscriptions.length, 1);
  });
});

describe("POST /api/billing/checkout", () => {
  const body = { kind: "plan", key: "pro", interval: "month" };
  const withPaddle = () => {
    paddleAnswers = {
      "GET /customers": () => jsonResponse(200, { data: [] }),
      "POST /customers": () => jsonResponse(201, { data: { id: "ctm_01created" } }),
      "POST /transactions": () => jsonResponse(201, { data: { id: "txn_01created" } }),
    };
  };

  it("answers 503 while Paddle, or the browser token, is not configured", async () => {
    delete process.env.PADDLE_APP_TAG;
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 503);
    process.env.PADDLE_APP_TAG = "test-app";
    delete process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 503);
  });

  it("answers 401 for a visitor who is not signed in, 400 for no e-mail, 400 for a bad body", async () => {
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 401);
    user = verified(USER_ID, null);
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 400);
    user = verified(USER_ID, "buyer@example.com");
    const bad = await checkout.POST(post("/api/billing/checkout", { kind: "plan", key: "pro" }));
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "invalid_request" });
  });

  it("refuses to link a Paddle customer to an e-mail address nobody has confirmed (it would expose the owner's customer portal)", async () => {
    withPaddle();
    user = { id: USER_ID, email: "victim@example.com", email_confirmed_at: null };
    const response = await checkout.POST(post("/api/billing/checkout", body));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "email_not_verified" });
    assert.equal(paddleCalls.length, 0, "Paddle was not asked about that address");
    assert.equal(db.tables.billing_customers.length, 0);
  });

  it("answers 404 for an item that does not exist and 503 for a price that is not configured", async () => {
    user = verified(USER_ID, "buyer@example.com");
    assert.equal((await checkout.POST(post("/api/billing/checkout", { kind: "plan", key: "enterprise", interval: "month" }))).status, 404);
    delete process.env.PADDLE_PRICE_PRO_MONTH;
    const response = await checkout.POST(post("/api/billing/checkout", body));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "price_not_configured" });
    assert.equal(paddleCalls.length, 0, "nothing was sent to Paddle");
  });

  it("links the user to a Paddle customer, creates the transaction on the server and returns what the browser needs", async () => {
    withPaddle();
    user = verified(USER_ID, "buyer@example.com");
    const response = await checkout.POST(post("/api/billing/checkout", { ...body, priceId: "pri_free", customerId: "ctm_other" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { transactionId: "txn_01created", clientToken: "test_clienttoken", environment: "sandbox" });
    assert.deepEqual(db.tables.billing_customers, [{ user_id: USER_ID, paddle_customer_id: "ctm_01created" }]);
    const transaction = paddleCalls.find((call) => call.method === "POST" && call.path === "/transactions");
    assert.deepEqual(transaction?.body, {
      items: [{ price_id: "pri_pro_month", quantity: 1 }],
      customer_id: "ctm_01created",
      collection_mode: "automatic",
      custom_data: { app: "test-app", user_id: USER_ID, item_key: "pro", interval: "month" },
    });
    const customer = paddleCalls.find((call) => call.method === "POST" && call.path === "/customers");
    assert.deepEqual(customer?.body, { email: "buyer@example.com", custom_data: { app: "test-app", user_id: USER_ID } });
  });

  it("reuses the linked customer on the next purchase (no customer calls to Paddle)", async () => {
    withPaddle();
    user = verified(USER_ID, "buyer@example.com");
    db.tables.billing_customers.push({ user_id: USER_ID, paddle_customer_id: "ctm_01existing" });
    assert.equal((await checkout.POST(post("/api/billing/checkout", { kind: "plan", key: "pro", interval: "year" }))).status, 200);
    assert.deepEqual(paddleCalls.map((call) => `${call.method} ${call.path}`), ["POST /transactions"]);
    assert.equal((paddleCalls[0].body as { customer_id: string }).customer_id, "ctm_01existing");
    assert.equal((paddleCalls[0].body as { items: { price_id: string }[] }).items[0].price_id, "pri_pro_year");
  });

  it("refuses a second subscription while one is running, past due or paused (the portal changes plans)", async () => {
    withPaddle();
    user = verified(USER_ID, "buyer@example.com");
    for (const status of ["active", "trialing", "past_due", "paused"]) {
      db.tables.billing_subscriptions.length = 0;
      db.tables.billing_subscriptions.push({ id: "sub_1", user_id: USER_ID, status, plan_key: "pro", billing_interval: "month", current_period_end: null, cancel_at_period_end: false });
      const response = await checkout.POST(post("/api/billing/checkout", body));
      assert.equal(response.status, 409, status);
      assert.deepEqual(await response.json(), { error: "already_subscribed" });
    }
    db.tables.billing_subscriptions.length = 0;
    db.tables.billing_subscriptions.push({ id: "sub_1", user_id: USER_ID, status: "canceled", plan_key: "pro", billing_interval: "month", current_period_end: null, cancel_at_period_end: false });
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 200, "a canceled one may subscribe again");
  });

  it("answers 502 with a stable code when Paddle fails, and 409 when the customer belongs to someone else", async () => {
    user = verified(USER_ID, "buyer@example.com");
    paddleAnswers = { "GET /customers": () => jsonResponse(500, { error: { code: "internal", detail: "boom" } }) };
    const failed = await checkout.POST(post("/api/billing/checkout", body));
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: "checkout_failed" });

    paddleAnswers = { "GET /customers": () => jsonResponse(200, { data: [{ id: "ctm_shared" }] }) };
    db.tables.billing_customers.push({ user_id: "99999999-9999-4999-8999-999999999999", paddle_customer_id: "ctm_shared" });
    const conflict = await checkout.POST(post("/api/billing/checkout", body));
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "customer_conflict" });
  });
});

describe("POST /api/billing/portal", () => {
  it("answers 401 without a session and 404 for someone who never bought anything", async () => {
    assert.equal((await portal.POST()).status, 401);
    user = verified(USER_ID, "buyer@example.com");
    const response = await portal.POST();
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "no_customer" });
  });

  it("returns a fresh portal link for the user's own customer, scoped to their running subscriptions", async () => {
    user = verified(USER_ID, "buyer@example.com");
    db.tables.billing_customers.push({ user_id: USER_ID, paddle_customer_id: CUSTOMER_ID });
    db.tables.billing_subscriptions.push({ id: "sub_live", user_id: USER_ID, status: "active" }, { id: "sub_old", user_id: USER_ID, status: "canceled" });
    paddleAnswers = {
      "POST /customers": () => jsonResponse(201, { data: { urls: { general: { overview: "https://sandbox-customer-portal.paddle.com/cpl_x" }, subscriptions: [{ cancel_subscription: "https://sandbox-customer-portal.paddle.com/cancel" }] } } }),
    };
    const response = await portal.POST();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: "https://sandbox-customer-portal.paddle.com/cpl_x", cancelUrl: "https://sandbox-customer-portal.paddle.com/cancel" });
    assert.equal(paddleCalls[0].path, `/customers/${CUSTOMER_ID}/portal-sessions`);
    assert.deepEqual(paddleCalls[0].body, { subscription_ids: ["sub_live"] });
  });
});

describe("POST /api/billing/sync", () => {
  it("answers 401 without a session, and the empty entitlement for someone with no Paddle customer", async () => {
    assert.equal((await sync.POST()).status, 401);
    user = verified("33333333-3333-4333-8333-333333333333", "new@example.com");
    const response = await sync.POST();
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { entitlement: { active: boolean } }).entitlement.active, false);
  });

  it("reads the customer's subscriptions from Paddle, applies them and answers the entitlement; a second call right away is throttled", async () => {
    user = verified("44444444-4444-4444-8444-444444444444", "sync@example.com");
    db.tables.billing_customers.push({ user_id: user.id, paddle_customer_id: "ctm_01sync" });
    paddleAnswers = {
      "GET /subscriptions": () => jsonResponse(200, { data: [{ ...subscriptionData({ customer_id: "ctm_01sync" }), updated_at: "2026-10-14T00:00:09Z" }] }),
      "GET /transactions": () => jsonResponse(200, { data: [] }),
    };
    const response = await sync.POST();
    assert.equal(response.status, 200);
    const json = (await response.json()) as { entitlement: { active: boolean; planKey: string | null } };
    assert.equal(json.entitlement.active, true);
    assert.equal(json.entitlement.planKey, "pro");
    assert.equal(db.tables.billing_subscriptions[0].user_id, user.id);
    assert.equal((await sync.POST()).status, 429);
  });
});
