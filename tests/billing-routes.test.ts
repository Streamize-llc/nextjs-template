// The route handlers, called for real with a fake Supabase (an in-memory database, a user session that tests switch on and off) and fake Paddle and
// Polar APIs. Covers both providers and what happens when `BILLING_PROVIDER` is switched under existing subscribers.
// Needs `--experimental-test-module-mocks` (the `test` script has it).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { signPaddleBody } from "@/lib/billing/paddle/signature";
import { signPolarBody } from "@/lib/billing/polar/signature";
import { billingDb } from "./support/fake-supabase";
import { adjustmentData, CUSTOMER_ID, event, polarOrderData, polarSubscriptionData, subscriptionData, transactionData, USER_ID } from "./support/billing-fixtures";

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

const paddleWebhook = await import("@/app/api/webhooks/paddle/route");
const polarWebhook = await import("@/app/api/webhooks/polar/route");
const checkout = await import("@/app/api/billing/checkout/route");
const portal = await import("@/app/api/billing/portal/route");
const sync = await import("@/app/api/billing/sync/route");
const { getEntitlement } = await import("@/lib/billing/entitlements");

const PADDLE_SECRET = "pdl_ntfset_test";
const POLAR_SECRET = `whsec_${Buffer.from("test-polar-secret-0123456789abcdef").toString("base64")}`;
const ENV_KEYS = [
  "BILLING_PROVIDER",
  "PADDLE_API_KEY",
  "PADDLE_APP_TAG",
  "PADDLE_WEBHOOK_SECRET",
  "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN",
  "NEXT_PUBLIC_PADDLE_ENVIRONMENT",
  "PADDLE_PRICE_PRO_MONTH",
  "PADDLE_PRICE_PRO_YEAR",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "POLAR_SERVER",
  "POLAR_PRODUCT_PRO_MONTH",
  "POLAR_PRODUCT_PRO_YEAR",
];
const realFetch = globalThis.fetch;
type Call = { method: string; path: string; query: string; body: unknown };
const paddleCalls: Call[] = [];
const polarCalls: Call[] = [];
let paddleAnswers: Record<string, () => Response> = {};
let polarAnswers: Record<string, () => Response> = {};

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    BILLING_PROVIDER: "paddle",
    PADDLE_API_KEY: "pdl_sdbx_apikey_test",
    PADDLE_APP_TAG: "test-app",
    PADDLE_WEBHOOK_SECRET: PADDLE_SECRET,
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_clienttoken",
    PADDLE_PRICE_PRO_MONTH: "pri_pro_month",
    PADDLE_PRICE_PRO_YEAR: "pri_pro_year",
    POLAR_ACCESS_TOKEN: "polar_oat_test",
    POLAR_WEBHOOK_SECRET: POLAR_SECRET,
    POLAR_PRODUCT_PRO_MONTH: "prod_pro_month",
    POLAR_PRODUCT_PRO_YEAR: "prod_pro_year",
  });
  db = billingDb();
  user = null;
  adminAvailable = true;
  paddleCalls.length = 0;
  polarCalls.length = 0;
  paddleAnswers = {};
  polarAnswers = {};
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const isPaddle = parsed.hostname === "sandbox-api.paddle.com";
    const isPolar = parsed.hostname === "sandbox-api.polar.sh";
    if (!isPaddle && !isPolar) throw new Error(`unexpected request to ${parsed.hostname}`);
    const method = init?.method ?? "GET";
    (isPaddle ? paddleCalls : polarCalls).push({ method, path: parsed.pathname, query: parsed.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answers = isPaddle ? paddleAnswers : polarAnswers;
    const key = Object.keys(answers).find((candidate) => `${method} ${parsed.pathname}`.startsWith(candidate));
    if (!key) throw new Error(`unexpected ${isPaddle ? "Paddle" : "Polar"} call ${method} ${parsed.pathname}`);
    return answers[key]();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const signed = (body: string) => post("/api/webhooks/paddle", body, { "paddle-signature": signPaddleBody(PADDLE_SECRET, body) });
const signedEvent = (type: string, data: unknown, occurredAt?: string, id?: string) => signed(JSON.stringify(event(type, data, occurredAt, id)));

let polarMessage = 0;
const polarBody = (type: string, data: unknown, timestamp = "2026-10-14T00:00:10Z") => JSON.stringify({ type, timestamp, data });
const polarRequest = (body: string, id = `msg_route_${(polarMessage += 1)}`, secret = POLAR_SECRET) => post("/api/webhooks/polar", body, signPolarBody(secret, id, body));
const signedPolar = (type: string, data: unknown, id?: string, timestamp?: string) => polarRequest(polarBody(type, data, timestamp), id);

const linkPaddle = (userId: string, customerId: string) => db.tables.billing_customers.push({ user_id: userId, paddle_customer_id: customerId });
const linkPolar = (userId: string) => db.tables.billing_customers.push({ user_id: userId, polar_linked_at: "2026-10-14T00:00:00.000Z" });
const polarCustomer = (userId: string) => ({ id: "polar-customer", external_id: userId, email: `${userId}@example.com` });
const storedSubscription = (provider: "paddle" | "polar", id: string, userId: string, over: Record<string, unknown> = {}) =>
  db.tables.billing_subscriptions.push({ provider, id, user_id: userId, status: "active", plan_key: "pro", billing_interval: "month", current_period_end: "2099-11-14T00:00:00Z", cancel_at_period_end: false, ...over });

describe("POST /api/webhooks/paddle", () => {
  it("answers 503 while Paddle is not configured, and never accepts anything without a webhook secret", async () => {
    delete process.env.PADDLE_API_KEY;
    assert.equal((await paddleWebhook.POST(post("/api/webhooks/paddle", "{}"))).status, 503);
    process.env.PADDLE_API_KEY = "pdl_sdbx_apikey_test";
    delete process.env.PADDLE_WEBHOOK_SECRET;
    const response = await paddleWebhook.POST(post("/api/webhooks/paddle", "{}", { "paddle-signature": signPaddleBody("", "{}") }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "webhook_secret_not_configured" });
  });

  it("refuses an unsigned, wrongly signed or tampered request with 401, and writes nothing", async () => {
    const body = JSON.stringify(event("subscription.created", subscriptionData()));
    assert.equal((await paddleWebhook.POST(post("/api/webhooks/paddle", body))).status, 401);
    assert.equal((await paddleWebhook.POST(post("/api/webhooks/paddle", body, { "paddle-signature": signPaddleBody("wrong", body) }))).status, 401);
    assert.equal((await paddleWebhook.POST(post("/api/webhooks/paddle", `${body} `, { "paddle-signature": signPaddleBody(PADDLE_SECRET, body) }))).status, 401);
    assert.equal(db.tables.billing_webhook_events.length, 0);
  });

  it("answers 400 for a signed body that is not an event", async () => {
    assert.equal((await paddleWebhook.POST(signed("not json"))).status, 400);
    assert.equal((await paddleWebhook.POST(signed(JSON.stringify({ hello: "world" })))).status, 400);
  });

  it("answers 503 when it cannot write (no service role key), so that Paddle tries again", async () => {
    adminAvailable = false;
    assert.equal((await paddleWebhook.POST(signedEvent("subscription.created", subscriptionData()))).status, 503);
  });

  it("applies a signed subscription event of a known customer, and a redelivery changes nothing", async () => {
    linkPaddle(USER_ID, CUSTOMER_ID);
    const first = await paddleWebhook.POST(signedEvent("subscription.created", subscriptionData(), "2026-10-14T00:00:10Z", "evt_route_1"));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, status: "processed" });
    assert.equal(db.tables.billing_subscriptions.length, 1);
    assert.equal(db.tables.billing_subscriptions[0].provider, "paddle");
    assert.equal(db.tables.billing_subscriptions[0].user_id, USER_ID);
    assert.equal(db.tables.billing_subscriptions[0].plan_key, "pro");

    db.tables.billing_subscriptions[0].status = "changed-by-test";
    const again = await paddleWebhook.POST(signedEvent("subscription.created", subscriptionData(), "2026-10-14T00:00:10Z", "evt_route_1"));
    assert.deepEqual(await again.json(), { ok: true, status: "duplicate" });
    assert.equal(db.tables.billing_subscriptions[0].status, "changed-by-test", "the duplicate was not applied");
    assert.equal(db.tables.billing_webhook_events.length, 1);
  });

  it("answers 200 and records `ignored` for a customer it does not know (never a retry storm)", async () => {
    const response = await paddleWebhook.POST(signedEvent("subscription.created", subscriptionData({ customer_id: "ctm_01stranger" }), "2026-10-14T00:00:10Z", "evt_stranger"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status: "ignored" });
    assert.equal(db.tables.billing_webhook_events[0].status, "ignored");
    assert.equal(db.tables.billing_subscriptions.length, 0);
  });

  it("records a payment and then its refund", async () => {
    linkPaddle(USER_ID, CUSTOMER_ID);
    assert.equal((await paddleWebhook.POST(signedEvent("transaction.completed", transactionData()))).status, 200);
    assert.equal((await paddleWebhook.POST(signedEvent("adjustment.created", adjustmentData({ totals: { total: "500" } })))).status, 200);
    assert.equal(db.tables.billing_transactions[0].total, 990);
    assert.equal(db.tables.billing_transactions[0].refunded, 500);
  });

  it("answers 500 when applying fails, and processes the redelivery", async () => {
    linkPaddle(USER_ID, CUSTOMER_ID);
    const original = db.from.bind(db);
    let broken = true;
    db.from = ((table: string) => {
      if (table === "billing_subscriptions" && broken) throw new Error("database is down");
      return original(table);
    }) as typeof db.from;
    const request = () => signedEvent("subscription.created", subscriptionData(), "2026-10-14T00:00:10Z", "evt_flaky");
    assert.equal((await paddleWebhook.POST(request())).status, 500);
    assert.equal(db.tables.billing_webhook_events[0].status, "failed");
    broken = false;
    assert.equal((await paddleWebhook.POST(request())).status, 200);
    assert.equal(db.tables.billing_subscriptions.length, 1);
  });
});

describe("POST /api/webhooks/polar", () => {
  it("answers 503 while Polar is not configured, and never accepts anything without a webhook secret", async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    assert.equal((await polarWebhook.POST(post("/api/webhooks/polar", "{}"))).status, 503);
    process.env.POLAR_ACCESS_TOKEN = "polar_oat_test";
    delete process.env.POLAR_WEBHOOK_SECRET;
    const response = await polarWebhook.POST(polarRequest("{}", "msg_1", ""));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "webhook_secret_not_configured" });
  });

  it("refuses an unsigned, wrongly signed or tampered request with 401, and writes nothing", async () => {
    const body = polarBody("subscription.active", polarSubscriptionData());
    assert.equal((await polarWebhook.POST(post("/api/webhooks/polar", body))).status, 401);
    assert.equal((await polarWebhook.POST(polarRequest(body, "msg_x", `whsec_${Buffer.from("another-secret-another-secret-12").toString("base64")}`))).status, 401);
    assert.equal((await polarWebhook.POST(post("/api/webhooks/polar", `${body} `, signPolarBody(POLAR_SECRET, "msg_y", body)))).status, 401);
    assert.equal(db.tables.billing_webhook_events.length, 0);
  });

  it("answers 400 for a signed body that is not an event, and 503 when it cannot write", async () => {
    assert.equal((await polarWebhook.POST(polarRequest("not json"))).status, 400);
    assert.equal((await polarWebhook.POST(polarRequest(JSON.stringify({ hello: "world" })))).status, 400);
    adminAvailable = false;
    assert.equal((await polarWebhook.POST(signedPolar("subscription.active", polarSubscriptionData({ customer: polarCustomer(USER_ID) })))).status, 503);
  });

  it("applies a signed subscription event for the user id the server set, and a redelivery changes nothing", async () => {
    const data = polarSubscriptionData({ customer: polarCustomer(USER_ID) });
    const first = await polarWebhook.POST(signedPolar("subscription.active", data, "msg_route_a"));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, status: "processed" });
    assert.equal(db.tables.billing_subscriptions[0].provider, "polar");
    assert.equal(db.tables.billing_subscriptions[0].user_id, USER_ID);
    assert.equal(db.tables.billing_subscriptions[0].plan_key, "pro");

    db.tables.billing_subscriptions[0].status = "changed-by-test";
    const again = await polarWebhook.POST(signedPolar("subscription.active", data, "msg_route_a"));
    assert.deepEqual(await again.json(), { ok: true, status: "duplicate" });
    assert.equal(db.tables.billing_subscriptions[0].status, "changed-by-test", "the duplicate was not applied");
  });

  it("answers 200 and records `ignored` for a payload without an external customer id or for a product that is not ours", async () => {
    const noExternal = await polarWebhook.POST(signedPolar("subscription.active", polarSubscriptionData({ customer: { id: "c", external_id: null } }), "msg_ne"));
    assert.deepEqual(await noExternal.json(), { ok: true, status: "ignored" });
    const foreign = await polarWebhook.POST(signedPolar("order.paid", polarOrderData({ product_id: "prod_other_app", customer: polarCustomer(USER_ID) }), "msg_fp"));
    assert.deepEqual(await foreign.json(), { ok: true, status: "ignored" });
    assert.deepEqual(db.tables.billing_webhook_events.map((row) => [row.event_id, row.status, row.note]).sort(), [["msg_fp", "ignored", "not_our_product"], ["msg_ne", "ignored", "no_customer"]]);
    assert.equal(db.tables.billing_subscriptions.length + db.tables.billing_transactions.length, 0);
  });

  it("answers 200 and records `ignored` for a payment of a user who no longer exists (never a retry storm)", async () => {
    db.users = new Set(["someone-else"]);
    const response = await polarWebhook.POST(signedPolar("order.paid", polarOrderData({ customer: polarCustomer(USER_ID) }), "msg_gone"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status: "ignored" });
    assert.deepEqual(db.tables.billing_webhook_events.map((row) => [row.event_id, row.status, row.note]), [["msg_gone", "ignored", "unknown_user"]]);
    assert.equal(db.tables.billing_transactions.length, 0);
  });

  it("records a payment and then its refund", async () => {
    const order = polarOrderData({ customer: polarCustomer(USER_ID) });
    assert.equal((await polarWebhook.POST(signedPolar("order.paid", order))).status, 200);
    const refunded = { ...order, status: "partially_refunded", refunded_amount: 500, refunded_tax_amount: 0, modified_at: "2026-10-15T00:00:00Z" };
    assert.equal((await polarWebhook.POST(signedPolar("order.updated", refunded))).status, 200);
    assert.equal(db.tables.billing_transactions[0].provider, "polar");
    assert.equal(db.tables.billing_transactions[0].total, 990);
    assert.equal(db.tables.billing_transactions[0].refunded, 500);
  });

  it("is processed whatever BILLING_PROVIDER says (that setting only picks the provider of NEW checkouts)", async () => {
    process.env.BILLING_PROVIDER = "paddle";
    assert.equal((await polarWebhook.POST(signedPolar("subscription.active", polarSubscriptionData({ customer: polarCustomer(USER_ID) })))).status, 200);
    process.env.BILLING_PROVIDER = "polar";
    linkPaddle(USER_ID, CUSTOMER_ID);
    assert.equal((await paddleWebhook.POST(signedEvent("subscription.created", subscriptionData()))).status, 200);
    assert.deepEqual(db.tables.billing_subscriptions.map((row) => row.provider).sort(), ["paddle", "polar"]);
  });
});

describe("POST /api/billing/checkout (Paddle)", () => {
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
    assert.deepEqual(await (await checkout.POST(post("/api/billing/checkout", body))).json(), { error: "billing_not_configured" });
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

  it("answers 404 for an item that does not exist and 503 for a price that is not configured, and 503 without a service role key", async () => {
    user = verified(USER_ID, "buyer@example.com");
    assert.equal((await checkout.POST(post("/api/billing/checkout", { kind: "plan", key: "enterprise", interval: "month" }))).status, 404);
    delete process.env.PADDLE_PRICE_PRO_MONTH;
    const response = await checkout.POST(post("/api/billing/checkout", body));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "price_not_configured" });
    assert.equal(paddleCalls.length, 0, "nothing was sent to Paddle");
    process.env.PADDLE_PRICE_PRO_MONTH = "pri_pro_month";
    adminAvailable = false;
    assert.deepEqual(await (await checkout.POST(post("/api/billing/checkout", body))).json(), { error: "supabase_admin_not_configured" });
  });

  it("links the user to a Paddle customer, creates the transaction on the server and returns what the browser needs", async () => {
    withPaddle();
    user = verified(USER_ID, "buyer@example.com");
    const response = await checkout.POST(post("/api/billing/checkout", { ...body, priceId: "pri_free", customerId: "ctm_other", provider: "polar" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { provider: "paddle", transactionId: "txn_01created", clientToken: "test_clienttoken", environment: "sandbox" });
    assert.deepEqual(db.tables.billing_customers, [{ user_id: USER_ID, paddle_customer_id: "ctm_01created" }]);
    const transaction = paddleCalls.find((call) => call.method === "POST" && call.path === "/transactions");
    assert.deepEqual(transaction?.body, {
      items: [{ price_id: "pri_pro_month", quantity: 1 }],
      customer_id: "ctm_01created",
      collection_mode: "automatic",
      custom_data: { app: "test-app", user_id: USER_ID, item_key: "pro", interval: "month" },
    });
    const created = paddleCalls.find((call) => call.method === "POST" && call.path === "/customers");
    assert.deepEqual(created?.body, { email: "buyer@example.com", custom_data: { app: "test-app", user_id: USER_ID } });
    assert.equal(polarCalls.length, 0, "the body's `provider` is not a way to pick Polar");
  });

  it("reuses the linked customer on the next purchase (no customer calls to Paddle)", async () => {
    withPaddle();
    user = verified(USER_ID, "buyer@example.com");
    linkPaddle(USER_ID, "ctm_01existing");
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
      storedSubscription("paddle", "sub_1", USER_ID, { status });
      const response = await checkout.POST(post("/api/billing/checkout", body));
      assert.equal(response.status, 409, status);
      assert.deepEqual(await response.json(), { error: "already_subscribed" });
    }
    db.tables.billing_subscriptions.length = 0;
    storedSubscription("paddle", "sub_1", USER_ID, { status: "canceled" });
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 200, "a canceled one may subscribe again");
  });

  it("answers 502 with a stable code when Paddle fails, and 409 when the customer belongs to someone else", async () => {
    user = verified(USER_ID, "buyer@example.com");
    paddleAnswers = { "GET /customers": () => jsonResponse(500, { error: { code: "internal", detail: "boom" } }) };
    const failed = await checkout.POST(post("/api/billing/checkout", body));
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: "checkout_failed" });

    paddleAnswers = { "GET /customers": () => jsonResponse(200, { data: [{ id: "ctm_shared" }] }) };
    linkPaddle("uid-someone-else", "ctm_shared");
    const conflict = await checkout.POST(post("/api/billing/checkout", body));
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "customer_conflict" });
    assert.equal(db.tables.billing_customers.find((row) => row.user_id === "uid-someone-else")?.paddle_customer_id, "ctm_shared");
  });
});

describe("POST /api/billing/checkout (Polar)", () => {
  const body = { kind: "plan", key: "pro", interval: "month" };
  beforeEach(() => {
    process.env.BILLING_PROVIDER = "polar";
    polarAnswers = { "POST /v1/checkouts": () => jsonResponse(201, { id: "chk_1", url: "https://sandbox.polar.sh/checkout/chk_1" }) };
  });

  it("creates the checkout on the server for the signed-in user and returns where to send the buyer", async () => {
    user = verified(USER_ID, "buyer@example.com");
    const response = await checkout.POST(post("/api/billing/checkout", { ...body, productId: "prod_free", externalCustomerId: "someone-else", provider: "paddle" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { provider: "polar", url: "https://sandbox.polar.sh/checkout/chk_1" });
    assert.deepEqual(polarCalls[0].body, {
      products: ["prod_pro_month"],
      external_customer_id: USER_ID,
      customer_email: "buyer@example.com",
      success_url: "http://localhost/billing/success?provider=polar&checkout_id={CHECKOUT_ID}",
      return_url: "http://localhost/pricing",
      metadata: { user_id: USER_ID, item_key: "pro", interval: "month" },
    });
    assert.equal(paddleCalls.length, 0);
    assert.equal(db.tables.billing_customers.length, 1);
    assert.equal(db.tables.billing_customers[0].user_id, USER_ID);
    assert.ok(db.tables.billing_customers[0].polar_linked_at);
    assert.equal(db.tables.billing_customers[0].paddle_customer_id, undefined);
  });

  it("does not need a confirmed e-mail (the Polar customer is the user id, not an address)", async () => {
    user = { id: USER_ID, email: "unconfirmed@example.com", email_confirmed_at: null };
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 200);
    user = { id: "uid-no-mail", email: null, email_confirmed_at: null };
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 200);
    assert.equal("customer_email" in (polarCalls[1].body as object), false);
  });

  it("still sells when Polar refuses the prefilled e-mail address: the buyer types it on Polar's page", async () => {
    user = verified(USER_ID, "buyer@nowhere.invalid");
    let attempt = 0;
    polarAnswers = {
      "POST /v1/checkouts": () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse(422, { detail: [{ loc: ["body", "customer_email"], msg: "value is not a valid email address: The domain does not exist", type: "value_error" }] })
          : jsonResponse(201, { id: "chk_2", url: "https://sandbox.polar.sh/checkout/chk_2" });
      },
    };
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 200);
    assert.equal(polarCalls.length, 2);
    assert.equal("customer_email" in (polarCalls[1].body as object), false);
  });

  it("answers 503 for a product that is not configured, 404 for an unknown item, 401 without a session", async () => {
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 401);
    user = verified(USER_ID, "buyer@example.com");
    delete process.env.POLAR_PRODUCT_PRO_MONTH;
    assert.deepEqual(await (await checkout.POST(post("/api/billing/checkout", body))).json(), { error: "price_not_configured" });
    assert.equal((await checkout.POST(post("/api/billing/checkout", { kind: "plan", key: "enterprise", interval: "month" }))).status, 404);
    delete process.env.POLAR_ACCESS_TOKEN;
    assert.deepEqual(await (await checkout.POST(post("/api/billing/checkout", body))).json(), { error: "billing_not_configured" });
    assert.equal(polarCalls.length, 0);
  });

  it("answers 502 with a stable code when Polar fails", async () => {
    user = verified(USER_ID, "buyer@example.com");
    polarAnswers = { "POST /v1/checkouts": () => jsonResponse(500, { detail: "boom" }) };
    const failed = await checkout.POST(post("/api/billing/checkout", body));
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: "checkout_failed" });
  });
});

describe("switching BILLING_PROVIDER under existing subscribers", () => {
  const body = { kind: "plan", key: "pro", interval: "month" };

  it("without BILLING_PROVIDER, and with both configured, no new checkout is taken (a switch must be a decision)", async () => {
    delete process.env.BILLING_PROVIDER;
    user = verified(USER_ID, "buyer@example.com");
    assert.deepEqual(await (await checkout.POST(post("/api/billing/checkout", body))).json(), { error: "billing_not_configured" });
    assert.equal(paddleCalls.length + polarCalls.length, 0);
  });

  it("a Paddle subscriber cannot start a second subscription at Polar after the switch (never billed twice)", async () => {
    storedSubscription("paddle", "sub_p", USER_ID);
    process.env.BILLING_PROVIDER = "polar";
    user = verified(USER_ID, "buyer@example.com");
    const response = await checkout.POST(post("/api/billing/checkout", body));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "already_subscribed" });
    assert.equal(polarCalls.length, 0);
  });

  it("a Polar subscriber cannot start a second subscription at Paddle after switching back", async () => {
    storedSubscription("polar", "uuid-1", USER_ID);
    process.env.BILLING_PROVIDER = "paddle";
    user = verified(USER_ID, "buyer@example.com");
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 409);
    assert.equal(paddleCalls.length, 0);
  });

  it("keeps updating a Paddle subscriber after the switch: their cancellation arrives, and the entitlement follows", async () => {
    linkPaddle(USER_ID, CUSTOMER_ID);
    assert.equal((await paddleWebhook.POST(signedEvent("subscription.created", subscriptionData(), "2026-10-14T00:00:10Z"))).status, 200);
    process.env.BILLING_PROVIDER = "polar";
    const scheduled = { action: "cancel", effective_at: "2026-11-14T00:00:00Z", resume_at: null };
    assert.equal((await paddleWebhook.POST(signedEvent("subscription.updated", subscriptionData({ scheduled_change: scheduled }), "2026-10-20T00:00:00Z"))).status, 200);
    const entitlement = await getEntitlement(db as never, USER_ID);
    assert.deepEqual({ active: entitlement.active, provider: entitlement.provider, cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd }, { active: true, provider: "paddle", cancelAtPeriodEnd: true });
  });

  it("opens the portal of the provider that BILLS the user, not the one that takes new checkouts", async () => {
    user = verified(USER_ID, "buyer@example.com");
    linkPaddle(USER_ID, CUSTOMER_ID);
    storedSubscription("paddle", "sub_p", USER_ID);
    process.env.BILLING_PROVIDER = "polar";
    paddleAnswers = { "POST /customers": () => jsonResponse(201, { data: { urls: { general: { overview: "https://paddle.example/portal" }, subscriptions: [{ cancel_subscription: "https://paddle.example/cancel" }] } } }) };
    const response = await portal.POST(post("/api/billing/portal"));
    assert.deepEqual(await response.json(), { provider: "paddle", url: "https://paddle.example/portal", cancelUrl: "https://paddle.example/cancel" });
    assert.equal(polarCalls.length, 0);
  });

  it("and a Polar subscriber's portal stays at Polar when new checkouts go to Paddle", async () => {
    user = verified(USER_ID, "buyer@example.com");
    linkPolar(USER_ID);
    storedSubscription("polar", "uuid-1", USER_ID);
    process.env.BILLING_PROVIDER = "paddle";
    polarAnswers = { "POST /v1/customer-sessions": () => jsonResponse(201, { customer_portal_url: "https://sandbox.polar.sh/portal/x" }) };
    const response = await portal.POST(post("/api/billing/portal"));
    assert.deepEqual(await response.json(), { provider: "polar", url: "https://sandbox.polar.sh/portal/x", cancelUrl: null });
    assert.deepEqual(polarCalls[0].body, { external_customer_id: USER_ID, return_url: "http://localhost/billing" });
    assert.equal(paddleCalls.length, 0);
  });

  it("the old provider only has to keep its server side after a switch: Paddle's portal needs no browser token or price ids any more", async () => {
    user = verified(USER_ID, "buyer@example.com");
    linkPaddle(USER_ID, CUSTOMER_ID);
    storedSubscription("paddle", "sub_p", USER_ID);
    process.env.BILLING_PROVIDER = "polar";
    for (const key of ["NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", "PADDLE_PRICE_PRO_MONTH", "PADDLE_PRICE_PRO_YEAR"]) delete process.env[key];
    paddleAnswers = { "POST /customers": () => jsonResponse(201, { data: { urls: { general: { overview: "https://paddle.example/portal" } } } }) };
    assert.equal((await portal.POST(post("/api/billing/portal"))).status, 200);
  });

  it("says so (503) instead of opening the wrong portal when the user's own provider is no longer configured", async () => {
    user = verified(USER_ID, "buyer@example.com");
    linkPaddle(USER_ID, CUSTOMER_ID);
    storedSubscription("paddle", "sub_p", USER_ID);
    process.env.BILLING_PROVIDER = "polar";
    delete process.env.PADDLE_API_KEY;
    assert.equal((await portal.POST(post("/api/billing/portal"))).status, 503);
    assert.equal(polarCalls.length + paddleCalls.length, 0);
  });

  it("a user who moved on: the new provider's running subscription wins over the old one's canceled row, and they may buy again once it is over", async () => {
    storedSubscription("paddle", "sub_old", USER_ID, { status: "canceled" });
    await polarWebhook.POST(signedPolar("subscription.active", polarSubscriptionData({ customer: polarCustomer(USER_ID) })));
    const entitlement = await getEntitlement(db as never, USER_ID);
    assert.deepEqual({ active: entitlement.active, provider: entitlement.provider }, { active: true, provider: "polar" });
    process.env.BILLING_PROVIDER = "polar";
    db.tables.billing_subscriptions.find((row) => row.provider === "polar")!.status = "canceled";
    polarAnswers = { "POST /v1/checkouts": () => jsonResponse(201, { id: "chk_3", url: "https://sandbox.polar.sh/checkout/chk_3" }) };
    user = verified(USER_ID, "buyer@example.com");
    assert.equal((await checkout.POST(post("/api/billing/checkout", body))).status, 200);
  });
});

describe("POST /api/billing/portal", () => {
  it("answers 401 without a session and 404 for someone who never bought anything", async () => {
    assert.equal((await portal.POST(post("/api/billing/portal"))).status, 401);
    user = verified(USER_ID, "buyer@example.com");
    const response = await portal.POST(post("/api/billing/portal"));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "no_customer" });
  });

  it("returns a fresh Paddle portal link for the user's own customer, scoped to their running subscriptions", async () => {
    user = verified(USER_ID, "buyer@example.com");
    linkPaddle(USER_ID, CUSTOMER_ID);
    storedSubscription("paddle", "sub_live", USER_ID);
    storedSubscription("paddle", "sub_old", USER_ID, { status: "canceled" });
    storedSubscription("paddle", "sub_other", "uid-other");
    paddleAnswers = {
      "POST /customers": () => jsonResponse(201, { data: { urls: { general: { overview: "https://sandbox-customer-portal.paddle.com/cpl_x" }, subscriptions: [{ cancel_subscription: "https://sandbox-customer-portal.paddle.com/cancel" }] } } }),
    };
    const response = await portal.POST(post("/api/billing/portal"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { provider: "paddle", url: "https://sandbox-customer-portal.paddle.com/cpl_x", cancelUrl: "https://sandbox-customer-portal.paddle.com/cancel" });
    assert.equal(paddleCalls[0].path, `/customers/${CUSTOMER_ID}/portal-sessions`);
    assert.deepEqual(paddleCalls[0].body, { subscription_ids: ["sub_live"] });
  });

  it("answers 404 when Polar does not know the user (nothing was paid there yet)", async () => {
    user = verified(USER_ID, "buyer@example.com");
    linkPolar(USER_ID);
    process.env.BILLING_PROVIDER = "polar";
    polarAnswers = { "POST /v1/customer-sessions": () => jsonResponse(422, { detail: [{ type: "value_error", loc: ["body", "external_customer_id"], msg: "Customer does not exist.", input: "x" }] }) };
    const response = await portal.POST(post("/api/billing/portal"));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "no_customer" });
  });
});

describe("POST /api/billing/sync", () => {
  it("answers 401 without a session, and the empty entitlement for someone who never started a checkout", async () => {
    assert.equal((await sync.POST()).status, 401);
    user = verified("uid-new", "new@example.com");
    const response = await sync.POST();
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { entitlement: { active: boolean } }).entitlement.active, false);
    assert.equal(paddleCalls.length + polarCalls.length, 0);
  });

  it("reads the Paddle customer's subscriptions, applies them and answers the entitlement; a second call right away is throttled", async () => {
    user = verified("uid-sync", "sync@example.com");
    linkPaddle("uid-sync", "ctm_01sync");
    paddleAnswers = {
      "GET /subscriptions": () => jsonResponse(200, { data: [{ ...subscriptionData({ customer_id: "ctm_01sync" }), updated_at: "2026-10-14T00:00:09Z" }] }),
      "GET /transactions": () => jsonResponse(200, { data: [] }),
    };
    const response = await sync.POST();
    assert.equal(response.status, 200);
    const json = (await response.json()) as { entitlement: { active: boolean; planKey: string | null; provider: string } };
    assert.equal(json.entitlement.active, true);
    assert.equal(json.entitlement.planKey, "pro");
    assert.equal(json.entitlement.provider, "paddle");
    assert.equal(db.tables.billing_subscriptions[0].user_id, "uid-sync");
    assert.equal((await sync.POST()).status, 429);
  });

  it("reads the user's subscriptions and orders from Polar (by external customer id), applies them, refunds included", async () => {
    user = verified("33333333-3333-4333-8333-333333333333", "p@example.com");
    linkPolar("33333333-3333-4333-8333-333333333333");
    polarAnswers = {
      "GET /v1/subscriptions": () => jsonResponse(200, { items: [polarSubscriptionData({ customer: polarCustomer("33333333-3333-4333-8333-333333333333") })], pagination: { total_count: 1, max_page: 1 } }),
      "GET /v1/orders": () => jsonResponse(200, { items: [polarOrderData({ status: "partially_refunded", refunded_amount: 300, refunded_tax_amount: 30, modified_at: "2026-10-15T00:00:00Z", customer: polarCustomer("33333333-3333-4333-8333-333333333333") })], pagination: { total_count: 1, max_page: 1 } }),
    };
    const response = await sync.POST();
    assert.equal(response.status, 200);
    const json = (await response.json()) as { entitlement: { active: boolean; provider: string } };
    assert.deepEqual({ active: json.entitlement.active, provider: json.entitlement.provider }, { active: true, provider: "polar" });
    assert.ok(polarCalls.every((call) => call.query.includes("external_customer_id=33333333-3333-4333-8333-333333333333")));
    assert.equal(db.tables.billing_transactions[0].refunded, 330);
  });

  it("asks both providers of a user who has been to both, and still answers when only one of them fails", async () => {
    user = verified("44444444-4444-4444-8444-444444444444", "both@example.com");
    db.tables.billing_customers.push({ user_id: "44444444-4444-4444-8444-444444444444", paddle_customer_id: "ctm_01both", polar_linked_at: "2026-10-14T00:00:00.000Z" });
    paddleAnswers = { "GET /subscriptions": () => jsonResponse(500, { error: { code: "internal", detail: "down" } }) };
    polarAnswers = {
      "GET /v1/subscriptions": () => jsonResponse(200, { items: [polarSubscriptionData({ customer: polarCustomer("44444444-4444-4444-8444-444444444444") })], pagination: { max_page: 1 } }),
      "GET /v1/orders": () => jsonResponse(200, { items: [], pagination: { max_page: 1 } }),
    };
    const response = await sync.POST();
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { entitlement: { active: boolean } }).entitlement.active, true);
  });

  it("answers 502 only when every provider it asked failed, and 503 when it cannot write", async () => {
    user = verified("uid-down", "down@example.com");
    linkPolar("uid-down");
    polarAnswers = { "GET /v1/subscriptions": () => jsonResponse(500, { detail: "down" }) };
    const response = await sync.POST();
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "sync_failed" });
    user = verified("uid-no-admin", "na@example.com");
    linkPolar("uid-no-admin");
    adminAvailable = false;
    assert.equal((await sync.POST()).status, 503);
  });

  it("does not ask a provider that is no longer configured, and still answers", async () => {
    user = verified("uid-gone", "gone@example.com");
    linkPaddle("uid-gone", "ctm_01gone");
    delete process.env.PADDLE_API_KEY;
    const response = await sync.POST();
    assert.equal(response.status, 200);
    assert.equal(paddleCalls.length, 0);
  });
});
