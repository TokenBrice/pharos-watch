import { TELEGRAM_LAUNCH_RETIRED_MESSAGE } from "@shared/lib/telegram-alert-families";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { FROZEN_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { TELEGRAM_PRESET_LABEL_BY_ID, type TelegramPresetId } from "../../common/presets";
import {
  createTelegramFetchSpy,
  mockTelegramD1 as baseMockD1,
  telegramApiCalls,
  telegramCallBody,
} from "../../../test-helpers/__shared/telegram";
import type { MockTableConfig } from "@shared/test-utils/mock-d1";
import type { MockTelegramD1Options } from "../../../test-helpers/__shared/telegram";

function mockD1(tables: MockTableConfig[] = [], options: MockTelegramD1Options = {}) {
  return baseMockD1(tables, {
    ...options,
    fallbackTables: [
      ...(options.fallbackTables ?? []),
      // Store enable batches include the idempotent first-follow claim.
      { match: "INSERT OR IGNORE INTO telegram_subscribers", rows: [] },
    ],
  });
}

import type { PresetSubscriptionRow, SubscriptionRow } from "../telegram-webhook-shared";

const {
  handleSettingsCallback,
  handleSettingsCommand,
} = await import("../telegram-webhook-settings");
const {
  buildCoinKeyboard,
  buildGlobalKeyboard,
  buildGlobalMessage,
  buildHomeKeyboard,
  buildHomeMessage,
  buildPresetKeyboard,
  buildPresetUnfollowConfirmKeyboard,
} = await import("../telegram-webhook-settings-render");

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function jsonBody(call: unknown[]): Record<string, unknown> {
  return telegramCallBody(call);
}

function lastItem<T>(items: readonly T[]): T {
  return items[items.length - 1]!;
}

function sendCalls(): unknown[][] {
  return telegramApiCalls(fetchSpy, "sendMessage");
}

function editCalls(): unknown[][] {
  return telegramApiCalls(fetchSpy, "editMessageText");
}

function ackCalls(): unknown[][] {
  return telegramApiCalls(fetchSpy, "answerCallbackQuery");
}

function subscriptionRow(stablecoinId: string): SubscriptionRow & Record<string, unknown> {
  return {
    stablecoin_id: stablecoinId,
    alert_dews: 1,
    alert_depeg: 0,
    alert_safety: 0,
    alert_launch: 0,
    dews_min_band: "ALERT",
    safety_mode: null,
    depeg_worsening_bps_step: null,
  };
}

/** The private-chat settings message every callback edits. */
const PRIVATE_MESSAGE = { chat: { id: 42, type: "private" }, message_id: 999 };
const openUsdcSettings = (db: Parameters<typeof handleSettingsCommand>[0]) => handleSettingsCommand(db, "fake-token", "42", null, "USDC");

beforeEach(() => {
  resetTelegramFetchSpy();
});

describe("handleSettingsCommand", () => {
  it("sends the home view with pause row, presets summary, and All stablecoins submenu", async () => {
    const db = mockD1();
    await handleSettingsCommand(db, "fake-token", "42", null, "");

    expect(sendCalls().length).toBe(1);
    const body = jsonBody(sendCalls()[0]) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(body.text).toContain("<b>Settings</b>");
    expect(body.text).toContain("Quiet hours: off (22:00-07:00 UTC)");
    expect(body.text).toContain("Presets: None");
    const callbacks = body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(callbacks).toEqual(
      expect.arrayContaining([
        "settings:q:1",
        "settings:sn:4h",
        "settings:sn:24h",
        "settings:sn:pause",
        "settings:g:0",
      ]),
    );
    expect(callbacks.some((c) => c.startsWith("settings:gt:"))).toBe(false);
  });

  it("adds 2-column 8/page paginated per-coin owner buttons to the home view", async () => {
    const db = mockD1([], {
      subscriptions: [
        "usdt-tether", "usdc-circle", "dai-makerdao", "pyusd-paypal", "usds-sky",
        "usde-ethena", "frax-frax", "lusd-liquity", "fdusd-first-digital",
      ].map(subscriptionRow),
    });
    await handleSettingsCommand(db, "fake-token", "42", null, "");
    db.assertAllMatchesUsed();

    const body = jsonBody(sendCalls()[0]) as {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> };
    };
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons.filter((button) => button.callback_data?.startsWith("settings:o:"))).toHaveLength(8);
    expect(buttons.some((button) => button.text === "1/2" && button.callback_data === "settings:home:0")).toBe(true);
    expect(buttons.some((button) => button.text === "Next ›" && button.callback_data === "settings:home:1")).toBe(true);
  });

  it("renders the coin view for /settings USDC", async () => {
    const db = mockD1();
    await openUsdcSettings(db);

    expect(sendCalls().length).toBe(1);
    const body = jsonBody(sendCalls()[0]) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(body.text).toContain("USDC settings");
    const buttons = body.reply_markup.inline_keyboard.flat();
    const callbacks = buttons.map((b) => b.callback_data);
    expect(buttons.map((b) => b.text)).toEqual(expect.arrayContaining(["DEWS: Alert+", "Warning+", "Danger only"]));
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:db:"))).toBe(true);
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:sm:"))).toBe(true);
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:ds:a:"))).toBe(true);
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:rs:"))).toBe(true);
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:lc:"))).toBe(false);
    expect(callbacks).toContain("settings:home:0");
  });

  it("renders inline settings:o buttons for ambiguous /settings <ticker> and guards non-subscribable coins", async () => {
    const db = mockD1();
    await handleSettingsCommand(db, "fake-token", "42", null, "USDF", { chatType: "supergroup" });
    const ambigBody = jsonBody(sendCalls()[0]) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(ambigBody.text).toContain("\"USDF\" matches");
    expect(ambigBody.text).not.toContain("/status");
    const ambigButtons = ambigBody.reply_markup.inline_keyboard.flat();
    expect(ambigButtons.length).toBeGreaterThan(1);
    for (const button of ambigButtons) expect(button.callback_data).toMatch(/^settings:o:[a-z0-9-]+$/);

    await handleSettingsCommand(db, "fake-token", "42", null, FROZEN_STABLECOINS[0]!.id, { chatType: "supergroup" });
    expect(jsonBody(sendCalls()[1]).text).toContain("not active for alerts");
  });

  it("rejects an unknown ticker with the same not-found path other commands use", async () => {
    const db = mockD1();
    await handleSettingsCommand(db, "fake-token", "42", null, "NOPE");
    expect(sendCalls().length).toBe(1);
    expect(jsonBody(sendCalls()[0]).text).toContain("No stablecoin or preset called");
  });
});

describe("per-coin local override descriptions", () => {
  it.each([
    ["dews", "DEWS", "db"],
    ["depeg", "Depeg", "ds"],
    ["safety", "Safety", "sm"],
    ["reserve", "Reserve", "rs"],
    ["freeze", "Freeze", "fz"],
  ])("distinguishes inherited zero from explicit %s off through the Store loader", async (family, label, code) => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id) VALUES ('42', 'usdc-circle')`);
    for (const marker of [0, 1]) {
      sqlite.exec(`UPDATE telegram_subscriptions SET alert_${family}_override = ${marker}`);
      await openUsdcSettings(db);
      const body = jsonBody(sendCalls()[marker]) as {
        text: string; reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      };
      expect(body.text).toContain(`${label}: ${marker ? "off (local override)" : "inherits chat"}`);
      expect(body.text).toContain("Local overrides");
      const off = body.reply_markup.inline_keyboard.flat().find((button) => button.callback_data.endsWith(`:${code}:0:0`));
      expect(off?.text.includes("\u2022")).toBe(marker === 1);
    }
  });

  it.each(["global-on", "preset-on", "unavailable-membership"])("does not claim inherited coverage is off with %s", async (source) => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_dews)
      VALUES ('42', 1, 1, ${source === "global-on" ? 1 : 0})`);
    if (source !== "global-on") {
      sqlite.exec(`INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews, alert_depeg, alert_safety, created_at, updated_at)
        VALUES ('42', 'usd-top25', 1, 0, 0, 1, 1);
        INSERT INTO telegram_subscriptions (chat_id, stablecoin_id) VALUES ('42', 'usdc-circle')`);
      if (source === "preset-on") {
        sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, 1)")
          .run(JSON.stringify({ peggedAssets: [{ id: "usdc-circle", circulating: { peggedUSD: 1_000_000 } }] }));
      }
    }
    await openUsdcSettings(db);
    expect(jsonBody(sendCalls()[0]).text).toContain("DEWS: inherits chat/preset policy");
    expect(jsonBody(sendCalls()[0]).text).not.toContain("DEWS: off");
  });

  it("shows enabled direct tuning in percent/compact terms instead of raw bps", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
      INSERT INTO telegram_subscriptions
        (chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, dews_min_band, safety_mode, depeg_worsening_bps_step)
      VALUES ('42', 'usdc-circle', 1, 1, 1, 'WARNING', 'downgrade-only', 250)`);
    await openUsdcSettings(db);
    const text = jsonBody(sendCalls()[0]).text;
    expect(text).toContain("DEWS: Warning+");
    expect(text).toContain("Safety: on");
    expect(text).toContain("Depeg: 2.5%");
  });
});

describe("handleSettingsCallback — chat-level, presets, and pause", () => {
  it("settings:g[:page] opens All stablecoins preserving returnPage and settings:gt sets target idempotently", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_dews) VALUES ('42', 1, 1, 0)");
    await handleSettingsCallback(db, "fake-token", {
      id: "cb", data: "settings:g:2", from: { id: 1 }, message: { chat: { id: 42, type: "group" }, message_id: 999 },
    }, "g", "2");
    const globalView = jsonBody(editCalls()[0]) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(globalView.text).toContain("<b>All stablecoins</b>");
    expect(globalView.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toContain("settings:home:2");

    for (let delivery = 0; delivery < 2; delivery += 1) {
      await handleSettingsCallback(db, "fake-token", {
        id: "cb", data: "settings:gt:dews:1:2", from: { id: 1, username: "alice" },
        message: PRIVATE_MESSAGE,
      }, "gt", "dews:1:2");
    }
    expect(sqlite.prepare("SELECT global_alert_dews FROM telegram_subscribers WHERE chat_id = '42'").get())
      .toEqual({ global_alert_dews: 1 });
    expect((jsonBody(lastItem(editCalls())) as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } })
      .reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toContain("settings:home:2");
    expect(jsonBody(ackCalls()[1]).text).toBe("Global dews on.");
  });

  it("manages followed presets (view, toggle, last-family lock, unfollow confirm + delete)", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
      INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews, alert_depeg, alert_safety, created_at, updated_at)
      VALUES ('42', 'usd-top25', 1, 1, 0, 1, 1)`);
    const cb = (data: string) => ({ id: "cb", data, from: { id: 1 }, message: { chat: { id: 42, type: "group" }, message_id: 999 } });

    await handleSettingsCallback(db, "fake-token", cb("settings:p:usd-top25:0"), "p", "usd-top25:0");
    expect(jsonBody(lastItem(editCalls())).text).toContain("<b>USD Top 25</b> (preset)");

    await handleSettingsCallback(db, "fake-token", cb("settings:pf:usd-top25:d:0:0"), "pf", "usd-top25:d:0:0");
    expect(sqlite.prepare("SELECT alert_dews, alert_depeg FROM telegram_preset_subscriptions").get())
      .toEqual({ alert_dews: 0, alert_depeg: 1 });

    // Trying to turn off the last active family leaves it enabled with an explanation.
    await handleSettingsCallback(db, "fake-token", cb("settings:pf:usd-top25:p:0:0"), "pf", "usd-top25:p:0:0");
    expect(sqlite.prepare("SELECT alert_depeg FROM telegram_preset_subscriptions").get()).toEqual({ alert_depeg: 1 });
    expect(jsonBody(lastItem(ackCalls())).text).toContain("Keep at least one alert on");

    await handleSettingsCallback(db, "fake-token", cb("settings:pu:usd-top25:0"), "pu", "usd-top25:0");
    expect(jsonBody(lastItem(editCalls())).text).toContain("Unfollow USD Top 25?");

    await handleSettingsCallback(db, "fake-token", cb("settings:pc:usd-top25:0"), "pc", "usd-top25:0");
    expect(sqlite.prepare("SELECT * FROM telegram_preset_subscriptions").all()).toEqual([]);
    expect(jsonBody(lastItem(ackCalls())).text).toBe("Unfollowed USD Top 25.");
  });

  it("settings:sn pauses for 4h / indefinitely and resumes alerts", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1)");
    const cb = (data: string) => ({ id: "cb", data, from: { id: 1 }, message: { chat: { id: 42, type: "group" }, message_id: 999 } });

    await handleSettingsCallback(db, "fake-token", cb("settings:sn:4h"), "sn", "4h");
    expect(jsonBody(lastItem(ackCalls())).text).toBe("All alerts paused for 4h.");
    expect(jsonBody(lastItem(editCalls())).text).toContain("Alerts: Paused");

    await handleSettingsCallback(db, "fake-token", cb("settings:sn:pause"), "sn", "pause");
    expect(jsonBody(lastItem(ackCalls())).text).toBe("All alerts paused until you resume.");
    expect(jsonBody(lastItem(editCalls())).text).toContain("Alerts: Paused (indefinite)");

    await handleSettingsCallback(db, "fake-token", cb("settings:sn:off"), "sn", "off");
    expect(jsonBody(lastItem(ackCalls())).text).toBe("Alerts resumed.");
    expect(sqlite.prepare("SELECT alert_snooze_until_ts FROM telegram_subscribers WHERE chat_id = '42'").get())
      .toEqual({ alert_snooze_until_ts: null });
  });

  it("refreshes instead of toggling on a bare pre-v2 settings:gt:<type> button", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_dews) VALUES ('42', 1, 1, 1)");
    await handleSettingsCallback(db, "fake-token", {
      id: "cb", data: "settings:gt:dews", from: { id: 1 }, message: PRIVATE_MESSAGE,
    }, "gt", "dews");
    expect(sqlite.prepare("SELECT global_alert_dews FROM telegram_subscribers WHERE chat_id = '42'").get())
      .toEqual({ global_alert_dews: 1 });
    expect(editCalls()).toHaveLength(1);
    expect(jsonBody(ackCalls()[0]).text).toContain("Tap again");
  });

  it("settings:q:1 enables quiet hours with the default 22-07 window", async () => {
    const { db, sqlite } = fixtures.open();
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:q:1",
        from: { id: 1, username: "alice" },
        message: PRIVATE_MESSAGE,
      },
      "q",
      "1",
    );

    expect(sqlite.prepare(`SELECT quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc
      FROM telegram_subscribers WHERE chat_id = '42'`).get())
      .toEqual({ quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7 });
    expect(ackCalls().length).toBe(1);
    expect(jsonBody(ackCalls()[0]).text).toContain("enabled");
  });

  it("settings:q:0 disables quiet hours", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers
      (chat_id, created_at, last_active_at, quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc, global_alert_reserve)
      VALUES ('42', 1, 1, 1, 22, 7, 1)`);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:q:0",
        from: { id: 1, username: "alice" },
        message: PRIVATE_MESSAGE,
      },
      "q",
      "0",
    );

    expect(sqlite.prepare(`SELECT quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
      global_alert_reserve FROM telegram_subscribers WHERE chat_id = '42'`).get()).toEqual({
      quiet_hours_enabled: 0, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7, global_alert_reserve: 1,
    });
  });

  it.each([
    [1, 9, 1, 9],
    [null, null, 22, 7],
    [3, 3, 22, 7],
    [-1, 9, 22, 7],
    [1, 24, 22, 7],
    [1.5, 9, 22, 7],
  ])("preserves valid saved quiet window %s-%s through OFF/ON", async (start, end, expectedStart, expectedEnd) => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO telegram_subscribers
      (chat_id, created_at, last_active_at, quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc)
      VALUES ('42', 1, 1, 1, ?, ?)`).run(start, end);
    for (const value of ["0", "1"]) {
      await handleSettingsCallback(db, "fake-token", {
        id: "cb", from: { id: 1 }, message: { chat: { id: 42 }, message_id: 999 },
      }, "q", value);
    }
    expect(sqlite.prepare(`SELECT quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc
      FROM telegram_subscribers WHERE chat_id = '42'`).get()).toEqual({
      quiet_hours_enabled: 1, quiet_hours_start_utc: expectedStart, quiet_hours_end_utc: expectedEnd,
    });
    expect(jsonBody(editCalls()[1]).text).toContain(`${String(expectedStart).padStart(2, "0")}:00`);
    expect(jsonBody(editCalls()[1]).text).toContain(`${String(expectedEnd).padStart(2, "0")}:00`);
  });

  it("settings:sc clears the snooze timestamp", async () => {
    const db = mockD1([{ match: "INSERT INTO telegram_subscribers", rows: [] }]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:sc",
        from: { id: 1, username: "alice" },
        message: PRIVATE_MESSAGE,
      },
      "sc",
      "",
    );

    expect(ackCalls().length).toBe(1);
    expect(jsonBody(ackCalls()[0]).text).toContain("Alerts resumed");
  });
});

describe("handleSettingsCallback — per-coin", () => {
  it("settings:o:<id>:<page> opens the coin view and preserves page in the Back button", async () => {
    const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:o:usdc-circle:2",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "o",
      "usdc-circle:2",
    );

    expect(editCalls().length).toBe(1);
    const body = jsonBody(editCalls()[0]) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(body.text).toContain("USDC settings");
    expect(body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toContain("settings:home:2");
  });

  it.each([
    ["db:W", "DEWS Warning+"],
    ["sm:a", "Safety on"],
    ["sm:d", "Safety downgrade-only"],
    ["ds:a", "Depeg on (any)"],
    ["ds:250", "2.5%"],
    ["ds:0", "Depeg off"],
    ["rs:1", "Reserve on"],
    ["db:0", "DEWS off"],
  ])("settings:c:<id>:%s edits the panel and acknowledges the setting", async (setting, acknowledgement) => {
    const db = mockD1([
      { match: "FROM telegram_subscriptions", rows: [] },
      { match: "INSERT INTO telegram_subscribers", rows: [] },
      { match: "INSERT INTO telegram_subscriptions", rows: [] },
    ]);
    await handleSettingsCallback(db, "fake-token", {
      id: "cb", data: `settings:c:usdc-circle:${setting}`, from: { id: 1, username: "alice" },
      message: PRIVATE_MESSAGE,
    }, "c", `usdc-circle:${setting}`);
    expect(editCalls()).toHaveLength(1);
    expect(jsonBody(editCalls()[0]).text).toContain("USDC settings");
    expect(ackCalls()).toHaveLength(1);
    expect(jsonBody(ackCalls()[0]).text).toContain(acknowledgement);
  });

  it("settings:c:<id>:ds:a replaces a numeric depeg step with default null while keeping depeg enabled", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg, depeg_worsening_bps_step)
      VALUES ('42', 'usdc-circle', 1, 250)`);
    await handleSettingsCallback(db, "fake-token", {
      id: "cb", data: "settings:c:usdc-circle:ds:a:0", from: { id: 1 },
      message: { chat: { id: 42, type: "group" }, message_id: 999 },
    }, "c", "usdc-circle:ds:a:0");
    expect(sqlite.prepare("SELECT alert_depeg, depeg_worsening_bps_step FROM telegram_subscriptions WHERE stablecoin_id = 'usdc-circle'").get())
      .toEqual({ alert_depeg: 1, depeg_worsening_bps_step: null });
  });

  it.each([["c", "usdc-circle:lc:1"], ["gt", "launch"]])("retired launch button settings:%s:%s answers a toast without writing", async (subAction, subArg) => {
    const db = mockD1();
    await handleSettingsCallback(db, "fake-token", {
      id: "cb", data: `settings:${subAction}:${subArg}`, from: { id: 1 },
      message: PRIVATE_MESSAGE,
    }, subAction, subArg);
    expect(jsonBody(ackCalls()[0]).text).toBe(TELEGRAM_LAUNCH_RETIRED_MESSAGE);
    expect(editCalls()).toHaveLength(0);
    expect(db.getHistory().some((entry) => /INSERT|UPDATE|DELETE/.test(entry.sql))).toBe(false);
  });

  it("falls back to sendMessage when editMessageText fails", async () => {
    const db = mockD1();
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("editMessageText")) {
        return new Response(JSON.stringify({ ok: false }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:home",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "home",
      "",
    );

    expect(editCalls().length).toBe(1);
    expect(sendCalls().length).toBe(1);
  });

  it("does not send a duplicate panel when editMessageText reports not modified", async () => {
    const db = mockD1();
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("editMessageText")) {
        return new Response(JSON.stringify({ ok: false, description: "Bad Request: message is not modified" }), {
          status: 400,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:home",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "home",
      "",
    );

    expect(editCalls().length).toBe(1);
    expect(sendCalls().length).toBe(0);
    expect(ackCalls().length).toBe(1);
  });
});

describe("callback_data size budget", () => {
  it("every settings keyboard callback across the full coin and preset registries stays <= 64 UTF-8 bytes at page 999", () => {
    const encoder = new TextEncoder();
    const checkAll = (buttons: ReadonlyArray<{ callback_data?: string }>) => {
      for (const button of buttons) {
        if (!button.callback_data) continue;
        expect(encoder.encode(button.callback_data).length, button.callback_data).toBeLessThanOrEqual(64);
      }
    };
    const allPresetRows: PresetSubscriptionRow[] = Array.from(TELEGRAM_PRESET_LABEL_BY_ID.keys()).map((presetId) => ({
      preset_id: presetId,
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 0,
      depeg_worsening_bps_step: null,
    }));
    const subscriber = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7,
      alert_snooze_until_ts: Math.floor(Date.now() / 1000) + 3600,
    };
    checkAll(buildGlobalKeyboard(subscriber, 999).inline_keyboard.flat());
    for (const presetId of TELEGRAM_PRESET_LABEL_BY_ID.keys() as IterableIterator<TelegramPresetId>) {
      checkAll(buildPresetKeyboard(presetId, allPresetRows[0]!, 999).inline_keyboard.flat());
      checkAll(buildPresetUnfollowConfirmKeyboard(presetId, 999).inline_keyboard.flat());
    }
    for (const coinId of TRACKED_META_BY_ID.keys()) {
      expect(coinId).toMatch(/^[a-z0-9-]+$/);
      checkAll(buildCoinKeyboard(coinId, null, { returnPage: 999 }).inline_keyboard.flat());
    }
    checkAll(
      buildHomeKeyboard(subscriber, {
        subscriptions: Array.from(TRACKED_META_BY_ID.keys()).map(subscriptionRow),
        presetSubscriptions: allPresetRows,
        subscriptionPage: 999,
      }).inline_keyboard.flat(),
    );
  });
});

describe("message builders", () => {
  it("global submenu states every alert family the global keyboard toggles", () => {
    const subscriber = {
      alert_dews: 0,
      alert_depeg: 0,
      alert_safety: 0,
      alert_launch: 0,
      global_alert_dews: 1,
      global_alert_depeg: 1,
      global_depeg_worsening_bps_step: 250,
      global_alert_safety: 0,
      global_alert_launch: 1,
      global_alert_reserve: 1,
      global_alert_freeze: 0,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      alert_snooze_until_ts: null,
    };

    const message = buildGlobalMessage(subscriber);
    expect(message).toContain("DEWS: ON");
    expect(message).toContain("Depeg: ON (2.5%)");
    expect(message).toContain("Safety: OFF");
    expect(message).toContain("Reserve: ON");
    expect(message).toContain("Freeze: OFF");

    const toggleLabels = buildGlobalKeyboard(subscriber)
      .inline_keyboard.flat()
      .flatMap((button) => (button.callback_data?.startsWith("settings:gt:") ? [button.text.split(":")[0]!] : []));
    expect(toggleLabels).toHaveLength(5);
    for (const label of toggleLabels) {
      expect(message).toContain(`\n${label}: `);
    }
  });

  it("never shows a depeg step that is not in force and shows saved quiet hours with TZ", () => {
    const subscriber = {
      alert_dews: 0,
      alert_depeg: 0,
      alert_safety: 0,
      alert_launch: 0,
      global_alert_dews: 0,
      global_alert_depeg: 0,
      global_depeg_worsening_bps_step: 250,
      global_alert_safety: 0,
      global_alert_launch: 0,
      global_alert_reserve: 0,
      global_alert_freeze: 0,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: 23,
      quiet_hours_end_utc: 6,
      timezone: "Europe/Paris",
      alert_snooze_until_ts: null,
    };
    const globalMsg = buildGlobalMessage(subscriber);
    expect(globalMsg).toContain("Depeg: OFF\n");
    expect(globalMsg).not.toContain("2.5%");
    expect(buildHomeMessage(subscriber)).toContain("Quiet hours: off (23:00-06:00 Europe/Paris)");
  });

  it("marks Any when depeg is on with null step and marks Off when explicitly overridden off", () => {
    const row = { alert_depeg: 1, depeg_worsening_bps_step: null } as unknown as SubscriptionRow;
    const depegButtons = buildCoinKeyboard("usdc-circle", row)
      .inline_keyboard.flat()
      .filter((button) => button.callback_data?.includes(":ds:") ?? false);
    expect(depegButtons.find((button) => button.callback_data?.includes(":ds:a:"))?.text).toContain("•Any");

    const offRow = { alert_depeg: 0, alert_depeg_override: 1, depeg_worsening_bps_step: 250 } as unknown as SubscriptionRow;
    const offButtons = buildCoinKeyboard("usdc-circle", offRow)
      .inline_keyboard.flat()
      .filter((button) => button.callback_data?.includes(":ds:") ?? false);
    expect(offButtons.find((button) => button.callback_data?.includes(":ds:0:"))?.text).toContain("•");
    expect(offButtons.find((button) => button.callback_data?.includes(":ds:250:"))?.text).not.toContain("•");
  });
});
