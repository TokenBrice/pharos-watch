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
    vi.clearAllMocks();
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
});
