import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { processDelivery } from "@/lib/billing/delivery";
import { UnknownUserError, type WebhookEventRecord } from "@/lib/billing/types";
import { MemoryStore } from "./support/billing-fixtures";

const record = (over: Partial<WebhookEventRecord> = {}): WebhookEventRecord => ({ provider: "paddle", event_id: "evt_1", event_type: "x", occurred_at: null, payload: {}, ...over });

describe("processDelivery (the same for every provider)", () => {
  it("claims, applies and records the outcome", async () => {
    const store = new MemoryStore();
    let applied = 0;
    const result = await processDelivery(store, record(), async () => {
      applied += 1;
      return { status: "processed", note: "done" };
    });
    assert.deepEqual(result, { status: "processed", note: "done" });
    assert.equal(applied, 1);
    assert.deepEqual(store.events.get("paddle_evt_1"), { status: "processed", note: "done" });
  });

  it("answers a duplicate without applying it again", async () => {
    const store = new MemoryStore();
    const apply = async () => ({ status: "processed" as const, note: "" });
    await processDelivery(store, record(), apply);
    let again = 0;
    const result = await processDelivery(store, record(), async () => {
      again += 1;
      return { status: "processed", note: "" };
    });
    assert.deepEqual(result, { status: "duplicate" });
    assert.equal(again, 0);
  });

  it("keeps the two providers' delivery ids apart", async () => {
    const store = new MemoryStore();
    const apply = async () => ({ status: "processed" as const, note: "" });
    await processDelivery(store, record({ provider: "paddle", event_id: "same" }), apply);
    const other = await processDelivery(store, record({ provider: "polar", event_id: "same" }), apply);
    assert.equal(other.status, "processed");
    assert.deepEqual([...store.events.keys()].sort(), ["paddle_same", "polar_same"]);
  });

  it("records a failure, rethrows it, and lets the redelivery through", async () => {
    const store = new MemoryStore();
    await assert.rejects(
      processDelivery(store, record(), async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual(store.events.get("paddle_evt_1"), { status: "failed", note: "boom" });
    const retried = await processDelivery(store, record(), async () => ({ status: "ignored", note: "later" }));
    assert.deepEqual(retried, { status: "ignored", note: "later" });
  });

  it("answers a payment of a user who no longer exists with ignored, not an error (a retry could never fix it)", async () => {
    const store = new MemoryStore();
    const result = await processDelivery(store, record(), async () => {
      throw new UnknownUserError();
    });
    assert.deepEqual(result, { status: "ignored", note: "unknown_user" });
    assert.deepEqual(store.events.get("paddle_evt_1"), { status: "ignored", note: "unknown_user" });
  });
});
