import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createTelegramFetchSpy } from "../../../test-helpers/__shared/telegram";
import { CALLBACK_HANDLERS, type CallbackAction } from "..";
import { handleSetupCallback } from "../setup";
import { buildPickKeyboard, coinIdHash, decodeSubscribeTypes, encodeSubscribeTypes } from "../pick";
import { parseCallbackData, type CallbackContext } from "../_shared";
import { resolveTicker } from "../../common/alerts-parser";

vi.mock("../../common/presets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../common/presets")>();
  return {
    ...actual,
    resolveTelegramPresetTargets: vi.fn(async () => ({
      kind: "ok",
      presets: [{
        definition: { id: "usd-top25" },
        stablecoinIds: ["usdc-circle"],
        coins: [{ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }],
      }],
    })),
  };
});

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();
const fixtures = createLatestSchemaFixtureTracker();
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];
const NOW = 1_800_000_000;

beforeEach(() => {
  resetTelegramFetchSpy();
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
  fixtures.closeAll();
});

function callbackContext(db: D1Database, data: string, chatType = "private"): CallbackContext & { answerCallback: ReturnType<typeof vi.fn> } {
  const parsed = parseCallbackData(data);
  return {
    db,
    botToken: "bot-token",
    chatId: "42",
    cb: { id: "cb-1", data, from: { id: 99, username: "alice" }, message: { chat: { id: 42, type: chatType } } },
    parsed: { ...parsed, action: parsed.action as CallbackAction },
    answerCallback: vi.fn().mockResolvedValue(undefined),
    beforeIrreversibleEffect: async () => undefined,
    markMutationApplied: async () => undefined,
  };
}

async function tap(db: D1Database, data: string, chatType = "private") {
  const ctx = callbackContext(db, data, chatType);
  await CALLBACK_HANDLERS[ctx.parsed.action as Exclude<CallbackAction, "settings">](ctx);
  return ctx;
}

function sentTexts(): string[] {
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).endsWith("/sendMessage"))
    .map(([, init]) => (JSON.parse(String(init!.body)) as { text: string }).text);
}

describe("pick buttons", () => {
  it("round-trips alert types and depeg steps through the callback code", () => {
    expect(decodeSubscribeTypes(encodeSubscribeTypes(new Set(["dews", "depeg"]), 250)))
      .toEqual({ alertTypes: new Set(["dews", "depeg"]), depegStep: 250 });
    expect(encodeSubscribeTypes(new Set(["safety"]), undefined)).toBe("4");
    expect(decodeSubscribeTypes("4")).toEqual({ alertTypes: new Set(["safety"]), depegStep: undefined });
    expect(encodeSubscribeTypes(new Set(["depeg"]), null)).toBe("2-0");
    expect(decodeSubscribeTypes("2-0")).toEqual({ alertTypes: new Set(["depeg"]), depegStep: null });
    expect(decodeSubscribeTypes("zz")).toBeNull();
    expect(decodeSubscribeTypes("3-7")).toBeNull();
  });

  it("binds each button to its coin id, not to a position", async () => {
    const candidates = resolveTicker("USDF", "subscribable");
    expect(candidates.status).toBe("ambiguous");
    const keyboard = buildPickKeyboard({ kind: "status" }, "USDF", [...candidates.matches].reverse());
    expect(keyboard!.inline_keyboard[0]![0]!.callback_data).toBe(`pick:st:USDF:${coinIdHash(last(candidates.matches)!.id)}`);
    for (const row of keyboard!.inline_keyboard) expect(new TextEncoder().encode(row[0]!.callback_data).length).toBeLessThanOrEqual(64);
  });

  it("re-resolves the ticker on tap and follows the chosen coin", async () => {
    const { sqlite, db } = fixtures.open();
    const candidates = resolveTicker("USDF", "subscribable");
    expect(candidates.status).toBe("ambiguous");
    const keyboard = buildPickKeyboard({ kind: "subscribe", alertTypes: new Set(["depeg"]), depegStep: null }, "USDF", candidates.matches);
    const data = keyboard!.inline_keyboard[1]![0]!.callback_data;
    const ctx = await tap(db, data);
    expect(sqlite.prepare("SELECT stablecoin_id, alert_depeg FROM telegram_subscriptions").all())
      .toEqual([{ stablecoin_id: candidates.matches[1]!.id, alert_depeg: 1 }]);
    expect(ctx.answerCallback).toHaveBeenCalledWith({ text: "Followed." });
  });

  it("a safety-only pick neither enables depeg nor clears a stored depeg step", async () => {
    const { sqlite, db } = fixtures.open();
    const candidates = resolveTicker("USDF", "subscribable");
    const coin = candidates.matches[0]!;
    sqlite.exec(`INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg, depeg_worsening_bps_step) VALUES ('42', '${coin.id}', 1, 500)`);
    const keyboard = buildPickKeyboard({ kind: "subscribe", alertTypes: new Set(["safety"]), depegStep: undefined }, "USDF", candidates.matches);
    await tap(db, keyboard!.inline_keyboard[0]![0]!.callback_data);
    expect(sqlite.prepare("SELECT alert_safety, alert_depeg, depeg_worsening_bps_step FROM telegram_subscriptions").get())
      .toEqual({ alert_safety: 1, alert_depeg: 1, depeg_worsening_bps_step: 500 });
  });

  it("refuses tampered or stale pick data without writing", async () => {
    const { sqlite, db } = fixtures.open();
    for (const data of ["pick:su:2:USDF:0", "pick:su:2:USDF:00000000", "pick:su:zz:USDF:00000000", "pick:un:NOTACOINXYZ:00000000", "pick:xx:USDF:00000000"]) {
      const ctx = await tap(db, data);
      expect(ctx.answerCallback).toHaveBeenCalledWith({ text: "This button is out of date. Send the command again." });
    }
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual([]);
  });
});

describe("bulk and forget confirmations", () => {
  const expiry = (NOW + 900).toString(36);

  it("follows every tracked coin from the button alone", async () => {
    const { sqlite, db } = fixtures.open();
    await tap(db, `bulk:sa:6:${expiry}`);
    expect(sqlite.prepare("SELECT global_alert_depeg, global_alert_safety, global_alert_dews FROM telegram_subscribers").get())
      .toEqual({ global_alert_depeg: 1, global_alert_safety: 1, global_alert_dews: 0 });
  });

  it("rejects an expired button and does nothing on cancel", async () => {
    const { sqlite, db } = fixtures.open();
    const expired = await tap(db, `bulk:sa:6:${(NOW - 1).toString(36)}`);
    expect(expired.answerCallback).toHaveBeenCalledWith({ text: "This confirmation expired. Send the command again." });
    const cancelled = await tap(db, "bulk:no");
    expect(cancelled.answerCallback).toHaveBeenCalledWith({ text: "Cancelled." });
    expect(sqlite.prepare("SELECT * FROM telegram_subscribers").all()).toEqual([]);
  });

  it("removes every follow on bulk:ua", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews) VALUES ('42', 'usdc-circle', 1)`);
    await tap(db, `bulk:ua:${expiry}`);
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual([]);
  });

  it("deletes the chat's data on forget:yes, private chats only", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews) VALUES ('42', 'usdc-circle', 1)`);
    const group = await tap(db, `forget:yes:${expiry}`, "group");
    expect(group.answerCallback).toHaveBeenCalledWith({ text: "Open a private chat with PharosWatchBot." });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_subscriptions").get()).toEqual({ n: 1 });

    await tap(db, `forget:yes:${expiry}`);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_subscriptions").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_subscribers").get()).toEqual({ n: 0 });
  });
});

describe("retired buttons in old messages", () => {
  it.each(["confirm:bulk:0123456789abcdef", "cancel:forget:0123456789abcdef", "manage:page:1", "unsub:usdc-circle", "select:1:0123456789abcdef", "tz:UTC"])(
    "%s answers a hint and writes nothing",
    async (data) => {
      const { sqlite, db } = fixtures.open();
      sqlite.exec(`INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews) VALUES ('42', 'usdc-circle', 1)`);
      const ctx = await tap(db, data);
      expect(ctx.answerCallback).toHaveBeenCalledOnce();
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_subscriptions").get()).toEqual({ n: 1 });
    },
  );
});

describe("setup buttons", () => {
  function tapSetup(db: D1Database, data: string) {
    return handleSetupCallback(db, "bot-token", { id: "cb", data, from: { id: 99 }, message: { chat: { id: 42, type: "private" } } }, "42", parseCallbackData(data));
  }

  function lastUndoData(): string | undefined {
    const sends = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/sendMessage"));
    const body = JSON.parse(String(last(sends)![1]!.body)) as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    return body.reply_markup?.inline_keyboard?.flat().find((button) => button.callback_data?.startsWith("setup:undo"))?.callback_data;
  }

  function lastAnswer(): string {
    const answers = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/answerCallbackQuery"));
    return (JSON.parse(String(last(answers)![1]!.body)) as { text: string }).text;
  }

  it("follows the top 25 in one tap, then undoes it", async () => {
    const { sqlite, db } = fixtures.open();
    await tapSetup(db, "setup:top25");
    expect(sqlite.prepare("SELECT preset_id, alert_dews, alert_depeg FROM telegram_preset_subscriptions").all())
      .toEqual([{ preset_id: "usd-top25", alert_dews: 1, alert_depeg: 1 }]);
    const done = last(sentTexts())!;
    expect(done).toContain("<b>Done.</b>");
    expect(done).toContain("Here's what an alert looks like:");
    const undo = lastUndoData()!;
    expect(undo).toBe(`setup:undo:0:${(NOW + 86_400).toString(36)}`);

    await tapSetup(db, undo);
    expect(sqlite.prepare("SELECT * FROM telegram_preset_subscriptions").all()).toEqual([]);
  });

  it("restores a partial prior follow on Undo instead of deleting it", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
      INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step, created_at, updated_at)
      VALUES ('42', 'usd-top25', 0, 1, 1, 250, 1, 1)`);
    await tapSetup(db, "setup:top25");
    expect(sqlite.prepare("SELECT alert_dews, alert_depeg, alert_safety FROM telegram_preset_subscriptions").get())
      .toEqual({ alert_dews: 1, alert_depeg: 1, alert_safety: 1 });
    const undo = lastUndoData()!;
    expect(undo).toBe(`setup:undo:6:${(NOW + 86_400).toString(36)}`);
    await tapSetup(db, undo);
    expect(sqlite.prepare("SELECT alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step FROM telegram_preset_subscriptions").get())
      .toEqual({ alert_dews: 0, alert_depeg: 1, alert_safety: 1, depeg_worsening_bps_step: 250 });
  });

  it("refuses an expired, tampered or bare Undo without writing", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews, alert_depeg, alert_safety, created_at, updated_at)
      VALUES ('42', 'usd-top25', 1, 1, 0, 1, 1)`);
    await tapSetup(db, `setup:undo:0:${(NOW - 1).toString(36)}`);
    expect(lastAnswer()).toContain("expired");
    await tapSetup(db, `setup:undo:8:${(NOW + 60).toString(36)}`);
    expect(lastAnswer()).toBe("Action not recognized.");
    await tapSetup(db, "setup:undo");
    expect(lastAnswer()).toContain("Send /start");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_preset_subscriptions").get()).toEqual({ n: 1 });
  });

  it("does not offer Undo when the chat already followed the preset", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews, alert_depeg, alert_safety, created_at, updated_at)
      VALUES ('42', 'usd-top25', 1, 1, 0, 1, 1)`);
    await tapSetup(db, "setup:top25");
    expect(lastUndoData()).toBeUndefined();
    expect(last(sentTexts())).toContain("You already follow");
  });

  it("answers retired wizard buttons with a restart hint", async () => {
    const { sqlite, db } = fixtures.open();
    await handleSetupCallback(db, "bot-token", { id: "cb", data: "setup:branch:recommended:0123456789abcdef", message: { chat: { id: 42, type: "private" } } }, "42", parseCallbackData("setup:branch:recommended:0123456789abcdef"));
    const answer = fetchSpy.mock.calls.find(([url]) => String(url).endsWith("/answerCallbackQuery"));
    expect(String(answer![1]!.body)).toContain("Send /start");
    expect(sqlite.prepare("SELECT * FROM telegram_preset_subscriptions").all()).toEqual([]);
  });
});
