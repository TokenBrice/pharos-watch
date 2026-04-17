import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleCallbackQuery } from "../telegram-webhook-callbacks";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
});

describe("handleCallbackQuery", () => {
  it("snooze:1h stamps alert_snooze_until_ts ~1h in the future in a single INSERT", async () => {
    const before = Math.floor(Date.now() / 1000);
    const db = mockD1([]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb1",
      data: "snooze:1h",
      from: { username: "alice" },
      message: { chat: { id: 42 }, message_id: 999 },
    });

    // One INSERT ... ON CONFLICT with the snooze timestamp bound in position 3.
    const history = db.getHistory();
    const upsert = history.find(
      (h) =>
        /INSERT INTO telegram_subscribers/.test(h.sql) &&
        /alert_snooze_until_ts = excluded\.alert_snooze_until_ts/.test(h.sql),
    );
    expect(upsert).toBeDefined();
    const until = Number(upsert!.binds[2]);
    expect(until).toBeGreaterThanOrEqual(before + 3599);
    expect(until).toBeLessThanOrEqual(before + 3700);

    // answerCallbackQuery should have been invoked.
    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
  });

  it("unknown callback data returns a graceful ack", async () => {
    const db = mockD1([]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb2",
      data: "garbage:whatever",
      message: { chat: { id: 42 }, message_id: 999 },
    });

    // No subscriber writes on unknown action.
    const history = db.getHistory();
    expect(history.some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);

    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
    const body = JSON.parse((ackCall?.[1] as RequestInit).body as string);
    expect(body.text).toBe("Action not recognized.");
  });

  it("silently acks a callback with no chat id", async () => {
    const db = mockD1([]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb3",
      data: "snooze:1h",
      message: {},
    });

    const history = db.getHistory();
    expect(history).toHaveLength(0);
    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
  });
});
