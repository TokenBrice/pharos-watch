import { beforeEach, describe, expect, it, vi } from "vitest";

const circuit = vi.hoisted(() => ({ shouldAttemptFetch: vi.fn() }));

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: circuit.shouldAttemptFetch,
}));

import { mapTelegramDigestPermittedDelivery, runTelegramDigestDeliveryWithPermit } from "../telegram-transport";

const creds = { botToken: "bot", chatId: "chat" };
const db = {} as D1Database;

describe("runTelegramDigestDeliveryWithPermit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("stays queued without crossing the send boundary while the Telegram circuit is open", async () => {
    circuit.shouldAttemptFetch.mockResolvedValue(false);
    const deliver = vi.fn();

    const status = await runTelegramDigestDeliveryWithPermit({
      db, creds, owner: "daily-digest", editionKey: "daily:2026-08-16", deliver,
    });

    expect(status).toBe("queued: transport-circuit-open");
    expect(deliver).not.toHaveBeenCalled();
    expect(circuit.shouldAttemptFetch).toHaveBeenCalledWith(db, "telegram-api");
  });

  it("delivers while the circuit is closed", async () => {
    circuit.shouldAttemptFetch.mockResolvedValue(true);
    expect(await runTelegramDigestDeliveryWithPermit({
      db, creds, owner: "weekly-recap", editionKey: "weekly:2026-08-16", deliver: async () => "ok",
    })).toBe("ok");
  });

  it("queues without delivery when the circuit cannot be read", async () => {
    circuit.shouldAttemptFetch.mockRejectedValue(new Error("circuit unavailable"));
    const deliver = vi.fn();
    expect(await runTelegramDigestDeliveryWithPermit({
      db, creds, owner: "daily-digest", editionKey: "daily:test", deliver,
    })).toBe("queued: transport-control-unavailable");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not send after an abort during the circuit read", async () => {
    const controller = new AbortController();
    circuit.shouldAttemptFetch.mockImplementation(async () => {
      controller.abort(new Error("stopped during admission"));
      return true;
    });
    const deliver = vi.fn();
    expect(await runTelegramDigestDeliveryWithPermit({
      db, creds, owner: "daily-digest", editionKey: "daily:test", deliver, signal: controller.signal,
    })).toBe("failed: Error: stopped during admission");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("reports a delivery failure", async () => {
    circuit.shouldAttemptFetch.mockResolvedValue(true);
    expect(await runTelegramDigestDeliveryWithPermit({
      db, creds, owner: "daily-digest", editionKey: "daily:test",
      deliver: vi.fn().mockRejectedValue(new Error("delivery unavailable")),
    })).toBe("failed: Error: delivery unavailable");
  });
});

describe("mapTelegramDigestPermittedDelivery", () => {
  const labels = { success: "ok", alreadySent: "skipped: already-sent" };

  it.each([
    [{ outcome: "sent", state: "sent", errorClass: null }, "ok"],
    [{ outcome: "skipped", state: "sent", errorClass: null }, "skipped: already-sent"],
    [{ outcome: "skipped", state: "sending", errorClass: null }, "queued: sending"],
    [{ outcome: "pending", state: "pending", errorClass: "rate_limit" }, "failed: Telegram digest pending: rate_limit"],
  ] as const)("maps %o to %s", (delivery, expected) => {
    expect(mapTelegramDigestPermittedDelivery(delivery, labels)).toBe(expected);
  });
});
