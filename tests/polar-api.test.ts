import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createCheckout, createPortalSession, isCustomerEmailRejection, isNoSuchCustomer, listOrders, listSubscriptions, PolarApiError, polarFetch } from "@/lib/billing/polar/api";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
const recorder = (answers: (call: Call, n: number) => Response) => {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answers(call, calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

const saved = { token: process.env.POLAR_ACCESS_TOKEN, server: process.env.POLAR_SERVER };
beforeEach(() => {
  process.env.POLAR_ACCESS_TOKEN = "polar_oat_test";
  delete process.env.POLAR_SERVER;
});
afterEach(() => {
  if (saved.token === undefined) delete process.env.POLAR_ACCESS_TOKEN;
  else process.env.POLAR_ACCESS_TOKEN = saved.token;
  if (saved.server === undefined) delete process.env.POLAR_SERVER;
  else process.env.POLAR_SERVER = saved.server;
});

describe("polarFetch", () => {
  it("sends the bearer token to the server POLAR_SERVER names (the sandbox by default)", async () => {
    const { calls, fetcher } = recorder(() => json(200, { ok: true }));
    await polarFetch("/v1/x", {}, fetcher);
    assert.equal(calls[0].url, "https://sandbox-api.polar.sh/v1/x");
    assert.equal(calls[0].headers.Authorization, "Bearer polar_oat_test");
    process.env.POLAR_SERVER = "production";
    await polarFetch("/v1/x", {}, fetcher);
    assert.equal(calls[1].url, "https://api.polar.sh/v1/x");
  });

  it("turns an error answer into a PolarApiError with a readable detail, whatever shape Polar used", async () => {
    for (const [body, expected] of [
      [{ detail: "Not found." }, "Not found."],
      [{ detail: [{ loc: ["body", "x"], msg: "bad" }] }, '[{"loc":["body","x"],"msg":"bad"}]'],
      [{ error: "insufficient_scope", error_description: "needs more privileges" }, "needs more privileges"],
      [{}, "Server Error"],
    ] as const) {
      const { fetcher } = recorder(() => new Response(JSON.stringify(body), { status: 500, statusText: "Server Error" }));
      await assert.rejects(polarFetch("/v1/x", {}, fetcher), (error: unknown) => error instanceof PolarApiError && error.status === 500 && error.detail === expected);
    }
  });

  it("is not fooled by an answer that is not JSON", async () => {
    const { fetcher } = recorder(() => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    await assert.rejects(polarFetch("/v1/x", {}, fetcher), (error: unknown) => error instanceof PolarApiError && error.status === 502 && error.detail === "Bad Gateway");
  });
});

describe("createPortalSession", () => {
  it("returns the portal link of the customer whose external id is the user", async () => {
    const { calls, fetcher } = recorder(() => json(201, { customer_portal_url: "https://sandbox.polar.sh/org/portal?token=x" }));
    assert.equal(await createPortalSession("user-1", "https://app.example/billing", fetcher), "https://sandbox.polar.sh/org/portal?token=x");
    assert.deepEqual(calls[0].body, { external_customer_id: "user-1", return_url: "https://app.example/billing" });
  });

  it("answers null (no customer yet) for what Polar really says when the external id is unknown: 422 'Customer does not exist.'", async () => {
    const real = [{ type: "value_error", loc: ["body", "external_customer_id"], msg: "Customer does not exist.", input: "user-1" }];
    const { fetcher } = recorder(() => json(422, { detail: real }));
    assert.equal(await createPortalSession("user-1", "https://app.example/billing", fetcher), null);
  });

  it("answers null for a 404 too, and throws for every other failure (a wrong token is not 'no customer')", async () => {
    assert.equal(await createPortalSession("u", "https://x", recorder(() => json(404, { error: "ResourceNotFound", detail: "Customer not found." })).fetcher), null);
    for (const response of [json(401, { error: "invalid_token" }), json(403, { error: "insufficient_scope" }), json(500, { detail: "boom" }), json(422, { detail: [{ loc: ["body", "return_url"], msg: "invalid url" }] })]) {
      await assert.rejects(createPortalSession("u", "https://x", recorder(() => response.clone()).fetcher), PolarApiError);
    }
  });

  it("throws when Polar answers without a link", async () => {
    await assert.rejects(createPortalSession("u", "https://x", recorder(() => json(201, {})).fetcher), /portal link/);
  });
});

describe("isNoSuchCustomer and isCustomerEmailRejection", () => {
  it("recognises exactly the answers that mean 'this customer is not at Polar'", () => {
    assert.equal(isNoSuchCustomer(new PolarApiError(404, "Not found.", "/x")), true);
    assert.equal(isNoSuchCustomer(new PolarApiError(422, '[{"msg":"Customer does not exist."}]', "/x")), true);
    assert.equal(isNoSuchCustomer(new PolarApiError(422, '[{"msg":"invalid url"}]', "/x")), false);
    assert.equal(isNoSuchCustomer(new PolarApiError(500, "Customer does not exist.", "/x")), false);
    assert.equal(isNoSuchCustomer(new Error("Customer does not exist.")), false);
  });

  it("recognises Polar's refusal of a prefilled e-mail address, and nothing else", () => {
    assert.equal(isCustomerEmailRejection(new Error('Polar /v1/checkouts/ -> 422: [{"loc":["body","customer_email"],"msg":"value is not a valid email address: The domain does not exist","type":"value_error"}]')), true);
    assert.equal(isCustomerEmailRejection(new Error('Polar /v1/checkouts/ -> 422: [{"loc":["body","products"],"msg":"bad","type":"value_error"}]')), false);
    assert.equal(isCustomerEmailRejection("nope"), false);
  });
});

describe("createCheckout", () => {
  const input = { productId: "prod_1", userId: "user-1", email: "a@example.com", successUrl: "https://app/success", returnUrl: "https://app/pricing", metadata: { item_key: "pro" } };

  it("creates it for the external customer, with the e-mail prefilled, and returns the id and the page", async () => {
    const { calls, fetcher } = recorder(() => json(201, { id: "chk_1", url: "https://sandbox.polar.sh/checkout/chk_1" }));
    assert.deepEqual(await createCheckout(input, fetcher), { id: "chk_1", url: "https://sandbox.polar.sh/checkout/chk_1" });
    assert.deepEqual(calls[0].body, { products: ["prod_1"], external_customer_id: "user-1", customer_email: "a@example.com", success_url: "https://app/success", return_url: "https://app/pricing", metadata: { item_key: "pro" } });
  });

  it("omits the e-mail when there is none, retries once without it when Polar refuses it, and gives up on any other refusal", async () => {
    const noMail = recorder(() => json(201, { id: "c", url: "https://x" }));
    await createCheckout({ ...input, email: null }, noMail.fetcher);
    assert.equal("customer_email" in (noMail.calls[0].body as object), false);

    const refuse = recorder((_call, n) => (n === 1 ? json(422, { detail: [{ loc: ["body", "customer_email"], msg: "value is not a valid email address", type: "value_error" }] }) : json(201, { id: "c", url: "https://x" })));
    await createCheckout(input, refuse.fetcher);
    assert.equal(refuse.calls.length, 2);
    assert.equal("customer_email" in (refuse.calls[1].body as object), false);

    const other = recorder(() => json(422, { detail: [{ loc: ["body", "products"], msg: "bad product", type: "value_error" }] }));
    await assert.rejects(createCheckout(input, other.fetcher), PolarApiError);
    assert.equal(other.calls.length, 1, "no retry for a refusal that is not about the e-mail");
  });

  it("throws when Polar answers without a checkout url", async () => {
    await assert.rejects(createCheckout(input, recorder(() => json(201, { id: "c" })).fetcher), /checkout url/);
  });
});

describe("listSubscriptions and listOrders", () => {
  it("filters by the external customer id (encoded) and follows the pages until the last", async () => {
    const { calls, fetcher } = recorder((call) => {
      const page = Number(new URL(call.url).searchParams.get("page"));
      return json(200, { items: [{ id: `s${page}` }], pagination: { total_count: 3, max_page: 3 } });
    });
    const subscriptions = await listSubscriptions("user 1/&x", fetcher);
    assert.deepEqual(subscriptions.map((s) => s.id), ["s1", "s2", "s3"]);
    assert.equal(calls.length, 3);
    assert.equal(new URL(calls[0].url).searchParams.get("external_customer_id"), "user 1/&x");
    assert.equal(new URL(calls[0].url).searchParams.get("limit"), "100");
    assert.equal(new URL(calls[0].url).pathname, "/v1/subscriptions/");
    const orders = await listOrders("u", recorder(() => json(200, { items: [{ id: "o1" }], pagination: { max_page: 1 } })).fetcher);
    assert.deepEqual(orders.map((o) => o.id), ["o1"]);
  });

  it("stops at ten pages whatever Polar claims, and survives an answer without pagination", async () => {
    const endless = recorder(() => json(200, { items: [{ id: "x" }], pagination: { max_page: 1_000_000 } }));
    assert.equal((await listOrders("u", endless.fetcher)).length, 10);
    assert.equal(endless.calls.length, 10);
    assert.deepEqual(await listOrders("u", recorder(() => json(200, {})).fetcher), []);
  });

  it("throws on an error answer instead of returning an empty list (an outage is not 'no subscriptions')", async () => {
    await assert.rejects(listSubscriptions("u", recorder(() => json(500, { detail: "down" })).fetcher), PolarApiError);
  });
});
