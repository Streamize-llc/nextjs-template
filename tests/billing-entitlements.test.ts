import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NO_LINKS } from "@/lib/billing/customers";
import { bestSubscription, entitlementFrom, getEntitlement, hasPurchased, NO_ENTITLEMENT, providerForUser, readLastPaymentProvider, readSubscriptions, type StoredSubscription } from "@/lib/billing/entitlements";
import { billingDb } from "./support/fake-supabase";
import { USER_ID } from "./support/billing-fixtures";

const row = (over: Partial<StoredSubscription> = {}): StoredSubscription => ({
  id: "sub_1",
  provider: "paddle",
  status: "active",
  plan_key: "pro",
  billing_interval: "month",
  current_period_end: "2026-11-14T00:00:00Z",
  cancel_at_period_end: false,
  ...over,
});

describe("entitlementFrom", () => {
  it("is nothing without a subscription", () => {
    assert.deepEqual(entitlementFrom([]), NO_ENTITLEMENT);
    assert.equal(NO_ENTITLEMENT.active, false);
    assert.equal(NO_ENTITLEMENT.provider, null);
  });

  it("is active for active and trialing, and keeps the cancellation notice", () => {
    for (const status of ["active", "trialing"]) assert.equal(entitlementFrom([row({ status })]).active, true, status);
    const ending = entitlementFrom([row({ cancel_at_period_end: true })]);
    assert.equal(ending.active, true);
    assert.equal(ending.cancelAtPeriodEnd, true);
    assert.equal(ending.currentPeriodEnd, "2026-11-14T00:00:00Z");
    assert.equal(ending.planKey, "pro");
    assert.equal(ending.subscriptionId, "sub_1");
  });

  it("is not active when paused, canceled or past due, and says so for past due", () => {
    for (const status of ["paused", "canceled", "past_due"]) assert.equal(entitlementFrom([row({ status })]).active, false, status);
    assert.equal(entitlementFrom([row({ status: "past_due" })]).pastDue, true);
    assert.equal(entitlementFrom([row({ status: "canceled" })]).pastDue, false);
  });

  it("prefers a running subscription over a past-due one over an old canceled one", () => {
    const old = row({ id: "sub_old", status: "canceled", plan_key: "team", current_period_end: "2027-01-01T00:00:00Z" });
    const late = row({ id: "sub_late", status: "past_due", plan_key: "team" });
    const live = row({ id: "sub_live", status: "active", plan_key: "pro" });
    assert.equal(entitlementFrom([old, late, live]).subscriptionId, "sub_live");
    assert.equal(entitlementFrom([old, late]).subscriptionId, "sub_late");
    assert.equal(entitlementFrom([old]).subscriptionId, "sub_old");
  });

  it("breaks a tie between two running subscriptions with the later period end, compared as instants", () => {
    const a = row({ id: "a", current_period_end: "2026-11-01T00:00:00Z" });
    const b = row({ id: "b", current_period_end: "2026-12-01T00:00:00Z" });
    assert.equal(entitlementFrom([a, b]).subscriptionId, "b");
    assert.equal(entitlementFrom([b, a]).subscriptionId, "b");
    // "…00.5Z" sorts before "…00Z" as a string but is the later instant
    const early = row({ id: "early", current_period_end: "2026-12-01T00:00:00Z" });
    const late = row({ id: "late", current_period_end: "2026-12-01T00:00:00.500000Z" });
    assert.equal(entitlementFrom([early, late]).subscriptionId, "late");
  });
});

describe("a subscription of either provider counts the same", () => {
  it("is active whether Paddle or Polar bills it, and says which", () => {
    assert.deepEqual(
      [entitlementFrom([row({ provider: "paddle" })]), entitlementFrom([row({ provider: "polar", id: "uuid-1" })])].map((e) => [e.active, e.provider, e.planKey]),
      [
        [true, "paddle", "pro"],
        [true, "polar", "pro"],
      ],
    );
  });

  it("survives a switch: the running subscription of the old provider wins over the canceled one of the new", () => {
    const paddleRunning = row({ provider: "paddle", id: "sub_p", status: "active" });
    const polarCanceled = row({ provider: "polar", id: "uuid-2", status: "canceled", current_period_end: "2027-06-01T00:00:00Z" });
    const entitlement = entitlementFrom([polarCanceled, paddleRunning]);
    assert.equal(entitlement.active, true);
    assert.equal(entitlement.provider, "paddle");
    assert.equal(bestSubscription([polarCanceled, paddleRunning])?.id, "sub_p");
  });
});

describe("providerForUser: where this user's portal and sync live", () => {
  const input = (over: Partial<Parameters<typeof providerForUser>[0]> = {}) => ({ subscriptions: [], lastPaymentProvider: null, links: NO_LINKS, ...over });

  it("is the provider of the best subscription, even after BILLING_PROVIDER moved on", () => {
    const subscriptions = [row({ provider: "paddle", status: "active" })];
    assert.equal(providerForUser(input({ subscriptions, preferred: "polar", links: { paddleCustomerId: "ctm_1", polarLinked: true } })), "paddle");
  });

  it("a canceled subscription still points at the place where its invoices are", () => {
    assert.equal(providerForUser(input({ subscriptions: [row({ provider: "polar", status: "canceled" })], preferred: "paddle" })), "polar");
  });

  it("without a subscription it is the provider of the latest payment (a one-time purchase)", () => {
    assert.equal(providerForUser(input({ lastPaymentProvider: "polar", preferred: "paddle" })), "polar");
  });

  it("without any of those it is a provider the user started a checkout with, the preferred one first", () => {
    const links = { paddleCustomerId: "ctm_1", polarLinked: true };
    assert.equal(providerForUser(input({ links, preferred: "polar" })), "polar");
    assert.equal(providerForUser(input({ links, preferred: "paddle" })), "paddle");
    assert.equal(providerForUser(input({ links })), "paddle");
    assert.equal(providerForUser(input({ links: { paddleCustomerId: null, polarLinked: true }, preferred: "paddle" })), "polar");
  });

  it("is null for a user who never started a checkout", () => {
    assert.equal(providerForUser(input({ preferred: "paddle" })), null);
  });
});

describe("reading from the database (through the user's own session: Row Level Security keeps other users' rows out)", () => {
  const setup = () => {
    const db = billingDb();
    return { db, client: db as unknown as SupabaseClient };
  };
  const sub = (id: string, over: Record<string, unknown> = {}) => ({ id, provider: "paddle", user_id: USER_ID, status: "active", plan_key: "pro", billing_interval: "month", current_period_end: "2026-11-14T00:00:00Z", cancel_at_period_end: false, ...over });

  it("answers for the user id it is given, and only that one", async () => {
    const { db, client } = setup();
    db.tables.billing_subscriptions.push(sub("sub_a", { plan_key: "team", cancel_at_period_end: true }), sub("sub_b", { user_id: "someone-else" }));
    const entitlement = await getEntitlement(client, USER_ID);
    assert.deepEqual({ active: entitlement.active, planKey: entitlement.planKey, cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd, id: entitlement.subscriptionId, provider: entitlement.provider }, { active: true, planKey: "team", cancelAtPeriodEnd: true, id: "sub_a", provider: "paddle" });
    assert.equal((await getEntitlement(client, "nobody")).active, false);
  });

  it("sees a Polar subscriber and a subscriber of the old provider alike", async () => {
    const { db, client } = setup();
    db.tables.billing_subscriptions.push(sub("uuid-1", { provider: "polar", status: "canceled", current_period_end: "2027-06-01T00:00:00Z" }), sub("sub_p"));
    const entitlement = await getEntitlement(client, USER_ID);
    assert.deepEqual({ active: entitlement.active, provider: entitlement.provider }, { active: true, provider: "paddle" });
    assert.equal((await readSubscriptions(client, USER_ID)).length, 2);
  });

  it("reads the provider of the latest payment", async () => {
    const { db, client } = setup();
    assert.equal(await readLastPaymentProvider(client, USER_ID), null);
    db.tables.billing_transactions.push(
      { provider: "paddle", id: "t1", user_id: USER_ID, status: "completed", billed_at: "2026-10-01T00:00:00Z" },
      { provider: "polar", id: "t2", user_id: USER_ID, status: "completed", billed_at: "2026-11-01T00:00:00Z" },
    );
    assert.equal(await readLastPaymentProvider(client, USER_ID), "polar");
  });

  it("knows whether a one-time product is paid for and not fully refunded, whichever provider took the payment", async () => {
    const { db, client } = setup();
    const payment = (id: string, over: Record<string, unknown> = {}) => ({ provider: "paddle", id, user_id: USER_ID, status: "completed", item_key: "credits_100", total: 1000, refunded: 0, ...over });
    assert.equal(await hasPurchased(client, USER_ID, "credits_100"), false);
    db.tables.billing_transactions.push(payment("t1", { refunded: 1000 }));
    assert.equal(await hasPurchased(client, USER_ID, "credits_100"), false, "fully refunded");
    db.tables.billing_transactions.push(payment("o2", { provider: "polar", refunded: 400 }));
    assert.equal(await hasPurchased(client, USER_ID, "credits_100"), true, "partly refunded, bought through Polar");
    assert.equal(await hasPurchased(client, USER_ID, "other_product"), false);
    db.tables.billing_transactions.push(payment("t3", { user_id: "u2", status: "billed" }));
    assert.equal(await hasPurchased(client, "u2", "credits_100"), false, "not completed");
  });

  it("throws when a read fails, rather than answering no", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ data: null, error: { message: "boom" } }) }), then: (resolve: (value: unknown) => void) => resolve({ data: null, error: { message: "boom" } }) }) }) }) } as unknown as SupabaseClient;
    await assert.rejects(hasPurchased(broken, USER_ID, "credits_100"), /boom/);
    await assert.rejects(getEntitlement(broken, USER_ID), /boom/);
  });
});
