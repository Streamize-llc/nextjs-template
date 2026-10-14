import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entitlementFrom, hasPurchased, NO_ENTITLEMENT, type StoredSubscription } from "@/lib/paddle/entitlements";

const row = (over: Partial<StoredSubscription> = {}): StoredSubscription => ({
  id: "sub_1",
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

  it("breaks a tie between two running subscriptions with the later period end", () => {
    const a = row({ id: "a", current_period_end: "2026-11-01T00:00:00Z" });
    const b = row({ id: "b", current_period_end: "2026-12-01T00:00:00Z" });
    assert.equal(entitlementFrom([a, b]).subscriptionId, "b");
    assert.equal(entitlementFrom([b, a]).subscriptionId, "b");
  });
});

describe("hasPurchased", () => {
  const client = (rows: { total: number; refunded: number }[], error: { message: string } | null = null) => {
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq"]) builder[name] = () => builder;
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: rows, error });
    return { from: () => builder } as never;
  };

  it("is true for a payment that is not fully refunded, false when it is, or when there is none", async () => {
    assert.equal(await hasPurchased(client([{ total: 1000, refunded: 0 }]), "u", "credits_100"), true);
    assert.equal(await hasPurchased(client([{ total: 1000, refunded: 400 }]), "u", "credits_100"), true);
    assert.equal(await hasPurchased(client([{ total: 1000, refunded: 1000 }]), "u", "credits_100"), false);
    assert.equal(await hasPurchased(client([{ total: 1000, refunded: 1000 }, { total: 1000, refunded: 0 }]), "u", "credits_100"), true);
    assert.equal(await hasPurchased(client([]), "u", "credits_100"), false);
  });

  it("throws when the read fails, rather than answering no", async () => {
    await assert.rejects(hasPurchased(client([], { message: "boom" }), "u", "credits_100"), /boom/);
  });
});
