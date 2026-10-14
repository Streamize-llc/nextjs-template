import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PaddleApiError, ensureCustomerId } from "@/lib/paddle/api";
import { CustomerConflictError, ensureBillingCustomer } from "@/lib/paddle/customers";
import { billingDb } from "./support/fake-supabase";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "buyer@example.com" };
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("ensureBillingCustomer", () => {
  it("creates the Paddle customer once and links it to the user", async () => {
    const db = billingDb();
    let calls = 0;
    const create = async () => {
      calls += 1;
      return "ctm_new";
    };
    assert.equal(await ensureBillingCustomer(db as unknown as SupabaseClient, USER, "my-app", create), "ctm_new");
    assert.equal(await ensureBillingCustomer(db as unknown as SupabaseClient, USER, "my-app", create), "ctm_new");
    assert.equal(calls, 1, "the second call reads the link and does not call Paddle");
    assert.deepEqual(db.tables.billing_customers, [{ user_id: USER.id, paddle_customer_id: "ctm_new" }]);
  });

  it("hands Paddle the e-mail of the session and the app tag, nothing the browser sent", async () => {
    const db = billingDb();
    const seen: unknown[] = [];
    await ensureBillingCustomer(db as unknown as SupabaseClient, USER, "my-app", async (email, customData) => {
      seen.push(email, customData);
      return "ctm_x";
    });
    assert.deepEqual(seen, ["buyer@example.com", { app: "my-app", user_id: USER.id }]);
  });

  it("uses the link a concurrent request made a moment before", async () => {
    const db = billingDb();
    const create = async () => {
      db.tables.billing_customers.push({ user_id: USER.id, paddle_customer_id: "ctm_winner" });
      return "ctm_loser";
    };
    assert.equal(await ensureBillingCustomer(db as unknown as SupabaseClient, USER, "my-app", create), "ctm_winner");
    assert.equal(db.tables.billing_customers.length, 1);
  });

  it("refuses to share a Paddle customer between two users (two accounts, one e-mail)", async () => {
    const db = billingDb();
    db.tables.billing_customers.push({ user_id: OTHER, paddle_customer_id: "ctm_shared" });
    await assert.rejects(ensureBillingCustomer(db as unknown as SupabaseClient, USER, "my-app", async () => "ctm_shared"), CustomerConflictError);
    assert.equal(db.tables.billing_customers.length, 1);
  });
});

describe("ensureCustomerId (the Paddle API side)", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const env = { PADDLE_API_KEY: "pdl_sdbx_apikey_x", PADDLE_APP_TAG: "my-app" };

  it("reuses a customer that exists on the account (another app may have made it)", async () => {
    Object.assign(process.env, env);
    const seen: string[] = [];
    const fetcher = (async (url: string) => {
      seen.push(String(url));
      return json(200, { data: [{ id: "ctm_existing" }] });
    }) as unknown as typeof fetch;
    assert.equal(await ensureCustomerId("buyer@example.com", {}, fetcher), "ctm_existing");
    assert.equal(seen.length, 1);
    assert.match(seen[0], /sandbox-api\.paddle\.com\/customers\?email=buyer%40example\.com/);
  });

  it("creates one when there is none, and recovers from the 409 a racing request causes", async () => {
    Object.assign(process.env, env);
    const created = (async (url: string, init?: RequestInit) => (init?.method === "POST" ? json(201, { data: { id: "ctm_created" } }) : json(200, { data: [] }))) as unknown as typeof fetch;
    assert.equal(await ensureCustomerId("a@example.com", {}, created), "ctm_created");

    const conflict = (async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? json(409, { error: { code: "conflict", detail: "customer email conflicts with customer of id ctm_01racer" } }) : json(200, { data: [] })) as unknown as typeof fetch;
    assert.equal(await ensureCustomerId("a@example.com", {}, conflict), "ctm_01racer");
  });

  it("does not hide other Paddle errors", async () => {
    Object.assign(process.env, env);
    const broken = (async () => json(403, { error: { code: "forbidden", detail: "no permission" } })) as unknown as typeof fetch;
    await assert.rejects(ensureCustomerId("a@example.com", {}, broken), (error: unknown) => error instanceof PaddleApiError && error.status === 403 && error.code === "forbidden");
  });
});
