import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  claim: vi.fn(),
  record: vi.fn(),
}));

vi.mock("../../lib/telegram/transport-control", () => ({
  claimTelegramTransportPermit: transport.claim,
  recordTelegramTransportOutcomes: transport.record,
}));

import { runTelegramDigestDeliveryWithPermit } from "../telegram-digest-transport";

const creds = { botToken: "bot", chatId: "chat" };
const db = {} as D1Database;

describe("runTelegramDigestDeliveryWithPermit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transport.record.mockResolvedValue({ state: "closed" });
  });

  it("fails closed without crossing the send boundary when the fresh mode is paused", async () => {
    transport.claim.mockResolvedValue({
      allowed: false,
      mode: "fresh",
      maxDistinctChats: 0,
      reason: "operator_pause",
      circuitGeneration: 4,
      probeOwner: null,
      probeGeneration: null,
      pauseGeneration: 2,
      deferUntil: 1_800_000_000,
    });
    const deliver = vi.fn();

    const status = await runTelegramDigestDeliveryWithPermit({
      db,
      creds,
      owner: "daily-digest",
      editionKey: "daily:2026-08-16",
      deliver,
    });

    expect(status).toBe("queued: transport-operator_pause");
    expect(deliver).not.toHaveBeenCalled();
    expect(transport.claim).toHaveBeenCalledWith(db, expect.objectContaining({
      mode: "fresh",
      requestedDistinctChats: 1,
    }));
  });

  it("records the transport result only after the permitted delivery completes", async () => {
    transport.claim.mockResolvedValue({
      allowed: true,
      mode: "fresh",
      maxDistinctChats: 1,
      reason: "closed",
      circuitGeneration: 4,
      probeOwner: null,
      probeGeneration: null,
      pauseGeneration: null,
      deferUntil: null,
    });
    const order: string[] = [];
    const deliver = vi.fn(async () => {
      order.push("delivery-complete");
      return {
        status: "ok",
        transportOutcome: { ok: true, errorClass: null, retryAfterSec: null },
      };
    });
    transport.record.mockImplementation(async () => {
      order.push("outcome-recorded");
      return { state: "closed" };
    });

    const status = await runTelegramDigestDeliveryWithPermit({
      db,
      creds,
      owner: "weekly-recap",
      editionKey: "weekly:2026-08-16",
      deliver,
    });

    expect(status).toBe("ok");
    expect(order).toEqual(["delivery-complete", "outcome-recorded"]);
    expect(transport.record).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ allowed: true }),
      [{ chatId: "chat", result: expect.objectContaining({ ok: true }) }],
      expect.any(Number),
    );
  });

  it("queues without delivery when permit acquisition fails", async () => {
    transport.claim.mockRejectedValue(new Error("permit unavailable"));
    const deliver = vi.fn();
    expect(await runTelegramDigestDeliveryWithPermit({
      db, creds, owner: "daily-digest", editionKey: "daily:test", deliver,
    })).toBe("queued: transport-control-unavailable");
    expect(deliver).not.toHaveBeenCalled();
    expect(transport.record).not.toHaveBeenCalled();
  });

  it("releases an allowed permit without sending after abort during acquisition", async () => {
    const controller = new AbortController();
    let allow!: (value: { allowed: true }) => void;
    const promise = new Promise<{ allowed: true }>((resolve) => {
      allow = resolve;
    });
    transport.claim.mockReturnValue(promise);
    const deliver = vi.fn();
    const pending = runTelegramDigestDeliveryWithPermit({
      db, creds, owner: "daily-digest", editionKey: "daily:test", deliver, signal: controller.signal,
    });
    controller.abort(new Error("stopped during acquisition"));
    allow({ allowed: true });
    expect(await pending).toBe("failed: Error: stopped during acquisition");
    expect(deliver).not.toHaveBeenCalled();
    expect(transport.record).toHaveBeenCalledExactlyOnceWith(db, { allowed: true }, [], expect.any(Number));
  });

  it.each([false, true])("preserves delivery failure when release failure is %s", async (releaseFails) => {
    transport.claim.mockResolvedValue({ allowed: true });
    if (releaseFails) transport.record.mockRejectedValue(new Error("release unavailable"));
    const deliver = vi.fn().mockRejectedValue(new Error("delivery unavailable"));
    expect(await runTelegramDigestDeliveryWithPermit({
      db, creds, owner: "daily-digest", editionKey: "daily:test", deliver,
    })).toBe("failed: Error: delivery unavailable");
    expect(transport.record).toHaveBeenCalledExactlyOnceWith(db, { allowed: true }, [], expect.any(Number));
  });

  it("releases an already-handled delivery without inventing a successful send", async () => {
    transport.claim.mockResolvedValue({ allowed: true });
    expect(await runTelegramDigestDeliveryWithPermit({
      db, creds, owner: "daily-digest", editionKey: "daily:test",
      deliver: async () => ({ status: "already-sent", transportOutcome: null }),
    })).toBe("already-sent");
    expect(transport.record).toHaveBeenCalledExactlyOnceWith(db, { allowed: true }, [], expect.any(Number));
  });
});
