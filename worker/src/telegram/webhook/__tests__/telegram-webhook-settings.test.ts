import { TELEGRAM_LAUNCH_RETIRED_MESSAGE } from "@shared/lib/telegram-alert-families";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
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
      { match: "INSERT INTO telegram_adoption_daily", rows: [] },
    ],
  });
}

import type { SubscriptionRow } from "../telegram-webhook-shared";

const {
  handleSettingsCallback,
  handleSettingsCommand,
} = await import("../telegram-webhook-settings");
const {
  buildCoinKeyboard,
  buildHomeKeyboard,
  buildHomeMessage,
} = await import("../telegram-webhook-settings-render");

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function jsonBody(call: unknown[]): Record<string, unknown> {
  return telegramCallBody(call);
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

beforeEach(() => {
  resetTelegramFetchSpy();
});

describe("handleSettingsCommand", () => {
  it("sends the home view when called with no ticker", async () => {
    const db = mockD1();
    await handleSettingsCommand(db, "fake-token", "42", null, "");

    expect(sendCalls().length).toBe(1);
    const body = jsonBody(sendCalls()[0]) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(body.text).toContain("<b>Settings</b>");
    expect(body.text).toContain("Quiet hours: off");
    const callbacks = body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(callbacks).toEqual(
      expect.arrayContaining([
        "settings:q:1",
        "settings:gt:dews:1",
        "settings:gt:depeg:1",
        "settings:gt:safety:1",
        "settings:gt:reserve:1",
      ]),
    );
    expect(callbacks.some((c) => c.startsWith("settings:gt:launch"))).toBe(false);
  });

  it("adds paginated per-coin owner buttons to the home view", async () => {
    const db = mockD1([], {
      subscriptions: ["usdt-tether", "usdc-circle", "dai-makerdao", "pyusd-paypal", "usds-sky", "usde-ethena"].map(
        subscriptionRow,
      ),
    });
    await handleSettingsCommand(db, "fake-token", "42", null, "");
    db.assertAllMatchesUsed();

    const body = jsonBody(sendCalls()[0]) as {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> };
    };
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons.filter((button) => button.callback_data?.startsWith("settings:o:"))).toHaveLength(5);
    expect(buttons.some((button) => button.callback_data === "settings:home:1")).toBe(true);
  });

  it("renders the coin view for /settings USDC", async () => {
    const db = mockD1();
    await handleSettingsCommand(db, "fake-token", "42", null, "USDC");

    expect(sendCalls().length).toBe(1);
    const body = jsonBody(sendCalls()[0]) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(body.text).toContain("USDC settings");
    const callbacks = body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    // db / sm / ds / lc + home back button
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:db:"))).toBe(true);
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:sm:"))).toBe(true);
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:ds:"))).toBe(true);
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:rs:"))).toBe(true);
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:lc:"))).toBe(false);
    expect(callbacks).toContain("settings:home");
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
    ["dews", "DEWS min band", "db"],
    ["depeg", "Depeg step", "ds"],
    ["safety", "Safety mode", "sm"],
    ["reserve", "Reserve", "rs"],
    ["freeze", "Freeze alerts", "fz"],
  ])("distinguishes inherited zero from explicit %s off through the Store loader", async (family, label, code) => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id) VALUES ('42', 'usdc-circle')`);
    for (const marker of [0, 1]) {
      sqlite.exec(`UPDATE telegram_subscriptions SET alert_${family}_override = ${marker}`);
      await handleSettingsCommand(db, "fake-token", "42", null, "USDC");
      const body = jsonBody(sendCalls()[marker]) as {
        text: string; reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      };
      expect(body.text).toContain(`${label}: ${marker ? "off (local override)" : "inherits chat"}`);
      expect(body.text).toContain("Local overrides");
      const off = body.reply_markup.inline_keyboard.flat().find((button) => button.callback_data.endsWith(`:${code}:0`));
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
    await handleSettingsCommand(db, "fake-token", "42", null, "USDC");
    expect(jsonBody(sendCalls()[0]).text).toContain("DEWS min band: inherits chat/preset policy");
    expect(jsonBody(sendCalls()[0]).text).not.toContain("DEWS min band: off");
  });

  it("shows enabled direct tuning instead of an inherited or off claim", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
      INSERT INTO telegram_subscriptions
        (chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, dews_min_band, safety_mode, depeg_worsening_bps_step)
      VALUES ('42', 'usdc-circle', 1, 1, 1, 'WARNING', 'downgrade-only', 250)`);
    await handleSettingsCommand(db, "fake-token", "42", null, "USDC");
    const text = jsonBody(sendCalls()[0]).text;
    expect(text).toContain("DEWS min band: WARNING");
    expect(text).toContain("Safety mode: downgrade-only");
    expect(text).toContain("Depeg step: +250bps");
  });
});

describe("handleSettingsCallback — chat-level", () => {
  it("settings:gt:<type>:<value> sets the target value, so a redelivered tap stays put", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_dews) VALUES ('42', 1, 1, 0)");
    for (let delivery = 0; delivery < 2; delivery += 1) {
      await handleSettingsCallback(db, "fake-token", {
        id: "cb", data: "settings:gt:dews:1", from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      }, "gt", "dews:1");
    }
    expect(sqlite.prepare("SELECT global_alert_dews FROM telegram_subscribers WHERE chat_id = '42'").get())
      .toEqual({ global_alert_dews: 1 });
    expect(jsonBody(ackCalls()[0]).text).toBe("Global dews on.");
  });

  it("refreshes instead of toggling on a bare pre-v2 settings:gt:<type> button", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_dews) VALUES ('42', 1, 1, 1)");
    await handleSettingsCallback(db, "fake-token", {
      id: "cb", data: "settings:gt:dews", from: { id: 1 }, message: { chat: { id: 42, type: "private" }, message_id: 999 },
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
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
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
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
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
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      },
      "sc",
      "",
    );

    expect(ackCalls().length).toBe(1);
    expect(jsonBody(ackCalls()[0]).text).toContain("Snooze cleared");
  });
});

describe("handleSettingsCallback — per-coin", () => {
  it("settings:o:<id> opens the coin view via editMessageText", async () => {
    const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:o:usdc-circle",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "o",
      "usdc-circle",
    );

    expect(editCalls().length).toBe(1);
    const body = jsonBody(editCalls()[0]);
    expect(body.text as string).toContain("USDC settings");
  });

  it.each([
    ["db:W", "WARNING"],
    ["sm:d", "downgrade-only"],
    ["ds:250", "250bps"],
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
      message: { chat: { id: 42, type: "private" }, message_id: 999 },
    }, "c", `usdc-circle:${setting}`);
    expect(editCalls()).toHaveLength(1);
    expect(jsonBody(editCalls()[0]).text).toContain("USDC settings");
    expect(ackCalls()).toHaveLength(1);
    expect(jsonBody(ackCalls()[0]).text).toContain(acknowledgement);
  });

  it.each([["c", "usdc-circle:lc:1"], ["gt", "launch"]])("retired launch button settings:%s:%s answers a toast without writing", async (subAction, subArg) => {
    const db = mockD1();
    await handleSettingsCallback(db, "fake-token", {
      id: "cb", data: `settings:${subAction}:${subArg}`, from: { id: 1 },
      message: { chat: { id: 42, type: "private" }, message_id: 999 },
    }, subAction, subArg);
    expect(jsonBody(ackCalls()[0]).text).toBe(TELEGRAM_LAUNCH_RETIRED_MESSAGE);
    expect(editCalls()).toHaveLength(0);
    expect(db.getHistory().some((entry) => /INSERT|UPDATE|DELETE/.test(entry.sql))).toBe(false);
  });

  it("unknown setting code under settings:c:<id>:?? receives an unknown-setting acknowledgement", async () => {
    const db = mockD1();
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:c:usdc-circle:xx:1",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "c",
      "usdc-circle:xx:1",
    );

    expect(jsonBody(ackCalls()[0]).text).toMatch(/unknown/i);
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
  // Longest tracked stablecoin id is `isc-international-stable-currency` (33).
  const LONG_ID = "isc-international-stable-currency";

  it("every keyboard data field stays within Telegram's 64-byte limit", () => {
    const homeKb = buildHomeKeyboard(
      {
        alert_dews: 0,
        alert_depeg: 0,
        alert_safety: 0,
        alert_launch: 0,
        quiet_hours_enabled: 1,
        quiet_hours_start_utc: 22,
        quiet_hours_end_utc: 7,
        alert_snooze_until_ts: Math.floor(Date.now() / 1000) + 3600,
      },
      { subscriptions: [subscriptionRow(LONG_ID)] },
    );
    const coinKb = buildCoinKeyboard(LONG_ID, null);
    const sizes = [...homeKb.inline_keyboard.flat(), ...coinKb.inline_keyboard.flat()].map(
      (b) => new TextEncoder().encode(b.callback_data).length,
    );
    for (const size of sizes) {
      expect(size).toBeLessThanOrEqual(64);
    }
  });

  it("keeps settings coin callback data safe for every tracked coin id", () => {
    for (const coinId of TRACKED_META_BY_ID.keys()) {
      expect(coinId).toMatch(/^[a-z0-9-]+$/);
      const coinKb = buildCoinKeyboard(coinId, null);
      for (const button of coinKb.inline_keyboard.flat()) {
        expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("message builders", () => {
  it("home message states every global alert family the home keyboard toggles", () => {
    const subscriber = {
      alert_dews: 0,
      alert_depeg: 0,
      alert_safety: 0,
      alert_launch: 0,
      global_alert_dews: 1,
      global_alert_depeg: 1,
      global_depeg_worsening_bps_step: 25,
      global_alert_safety: 0,
      global_alert_launch: 1,
      global_alert_reserve: 1,
      global_alert_freeze: 0,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      alert_snooze_until_ts: null,
    };

    const message = buildHomeMessage(subscriber);
    expect(message).toContain("<b>Global alerts</b>\nDEWS: ON\nDepeg: ON (+25bps)\nSafety: OFF\nReserve: ON\nFreeze: OFF\n");

    // Regression pin: the hand-written copy listed only DEWS/Depeg/Safety/Launch
    // while buildHomeKeyboard rendered a toggle row for all six, so a chat with
    // global Reserve or Freeze on saw the toggle but never the state line.
    const toggleLabels = buildHomeKeyboard(subscriber)
      .inline_keyboard.flat()
      .flatMap((button) => (button.callback_data?.startsWith("settings:gt:") ? [button.text.split(":")[0]!] : []));
    expect(toggleLabels).toHaveLength(5);
    for (const label of toggleLabels) {
      expect(message).toContain(`\n${label}: `);
    }
  });

  it("never shows a depeg step that is not in force", () => {
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
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      alert_snooze_until_ts: null,
    };
    const message = buildHomeMessage(subscriber);
    expect(message).toContain("Depeg: OFF\n");
    expect(message).not.toContain("(+250bps)");
  });

  it("marks no per-coin step when the depeg family is on without one", () => {
    const row = { alert_depeg: 1, depeg_worsening_bps_step: null } as unknown as SubscriptionRow;
    const depegButtons = buildCoinKeyboard("usdc-circle", row)
      .inline_keyboard.flat()
      .filter((button) => button.callback_data?.includes(":ds:") ?? false);
    expect(depegButtons.some((button) => button.text.includes("•"))).toBe(false);

    const offRow = { alert_depeg: 0, alert_depeg_override: 1, depeg_worsening_bps_step: 250 } as unknown as SubscriptionRow;
    const offButtons = buildCoinKeyboard("usdc-circle", offRow)
      .inline_keyboard.flat()
      .filter((button) => button.callback_data?.includes(":ds:") ?? false);
    expect(offButtons.find((button) => button.callback_data?.endsWith(":ds:0"))?.text).toContain("•");
    expect(offButtons.find((button) => button.callback_data?.endsWith(":ds:250"))?.text).not.toContain("•");
  });
});
