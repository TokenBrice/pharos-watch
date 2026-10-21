import { describe, expect, it, beforeEach } from "vitest";
import { mockTelegramMembership } from "../../../test-helpers/__shared/telegram";
import {
  fetchSpy,
  firstAckBody,
  handleCallbackQuery,
  makeCallbackQuery,
  lastAckBody,
  mockTelegramD1,
  resetCallbackTest,
} from "./telegram-webhook-callbacks.test-support.ts";















beforeEach(resetCallbackTest);

describe("handleCallbackQuery", () => {
  it.each(["recap:on", "recap:off", "recap:h:9"])("rejects retired %s callbacks without preference access", async (data) => {
    const db = mockTelegramD1();
    await handleCallbackQuery(db, "fake-token", makeCallbackQuery(data));
    expect(lastAckBody().text).toBe("Action not recognized.");
    expect(db.getHistory().every((entry) => !/telegram_(?:subscribers|recap_)/.test(entry.sql))).toBe(true);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith("/sendMessage"))).toBe(false);
  });
  it("snooze:1h stamps alert_snooze_until_ts ~1h in the future in a single INSERT", async () => {
    const before = Math.floor(Date.now() / 1000);
    const db = mockTelegramD1([]);
    await handleCallbackQuery(db, "fake-token", makeCallbackQuery("snooze:1h", { from: { username: "alice" }, message: { chat: { id: 42 }, message_id: 999 } }));

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

  it("does not overwrite group subscriber username with the callback actor username", async () => {
    const db = mockTelegramD1([], {
      fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
    });
    mockTelegramMembership(fetchSpy, "administrator", { id: 7, is_bot: false, first_name: "admin" });
    await handleCallbackQuery(db, "fake-token", makeCallbackQuery("snooze:1h", { id: "cb1-group", from: { id: 7, username: "tapping_user" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 999 } }));

    const upsert = db.getHistory().find((h) => /INSERT INTO telegram_subscribers/.test(h.sql));
    expect(upsert).toBeDefined();
    expect(upsert!.binds[1]).toBeNull();
  });

  it.each([undefined, { username: "mallory" }])("unknown callback gracefully acknowledges actor %j and records only one usage event", async (from) => {
    const db = mockTelegramD1([]);
    await handleCallbackQuery(db, "fake-token", makeCallbackQuery("garbage:whatever", { id: "cb2", from, message: { chat: { id: 42 }, message_id: 999 } }));

    // No subscriber writes on unknown action.
    const history = db.getHistory();
    expect(history).toHaveLength(1);
    const usageRow = history.find((h) => h.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(usageRow).toBeDefined();
    expect(usageRow!.binds[1]).toBe("unknown_command");
    expect(usageRow!.binds[3]).toBe("unknown");
    expect(usageRow!.binds[4]).toBe("unknown");
    expect(usageRow!.binds[6]).toBe("");

    const body = firstAckBody();
    expect(body.text).toBe("Action not recognized.");
  });


  it("silently acks a callback with no chat id", async () => {
    const db = mockTelegramD1([]);
    await handleCallbackQuery(db, "fake-token", makeCallbackQuery("snooze:1h", { id: "cb3", from: undefined, message: {} }));

    const history = db.getHistory();
    expect(history).toHaveLength(0);
    expect(firstAckBody()).toBeDefined();
  });


  it("depegstep in a group refuses non-admins without writing", async () => {
    const db = mockTelegramD1([], {
      fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
    });
    mockTelegramMembership(fetchSpy, "member", { id: 7, is_bot: false, first_name: "member" });

    await handleCallbackQuery(db, "fake-token", makeCallbackQuery("depegstep:usdc-circle:250", { id: "cb-depegstep-group", from: { id: 7, username: "member" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 1 } }));

    const history = db.getHistory();
    expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(false);
    const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/i);
  });

  it("setup:top25 in a group refuses non-admins without writing", async () => {
    const db = mockTelegramD1([], {
      fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
    });
    mockTelegramMembership(fetchSpy, "member", { id: 7, is_bot: false, first_name: "member" });

    await handleCallbackQuery(db, "fake-token", makeCallbackQuery("setup:top25", { id: "cb-setup-group", from: { id: 7, username: "member" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 1 } }));

    expect(db.getHistory().some((h) => /INSERT|UPDATE|DELETE/.test(h.sql) && !h.sql.includes("telegram_usage_daily"))).toBe(false);
    const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/i);
  });

});
