import { beforeEach, describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  createTelegramFetchSpy,
  mockTelegramD1 as mockD1,
  telegramApiCalls,
  telegramCallBody,
} from "../../test-helpers/__shared/telegram";
import { PAUSE_SENTINEL_TS } from "../../lib/telegram/constants";
import type { SubscriptionRow } from "../telegram-webhook-shared";

const {
  handleSettingsCallback,
  handleSettingsCommand,
} = await import("../telegram-webhook-settings");
const {
  buildCoinKeyboard,
  buildCoinMessage,
  buildHomeKeyboard,
  buildHomeMessage,
} = await import("../telegram-webhook-settings-render");

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();

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
        "settings:gt:dews",
        "settings:gt:depeg",
        "settings:gt:safety",
        "settings:gt:launch",
      ]),
    );
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
    expect(callbacks.some((c) => c.startsWith("settings:c:usdc-circle:lc:"))).toBe(true);
    expect(callbacks).toContain("settings:home");
  });

  it("rejects an unknown ticker with the same not-found path other commands use", async () => {
    const db = mockD1();
    await handleSettingsCommand(db, "fake-token", "42", null, "NOPE");
    expect(sendCalls().length).toBe(1);
    expect(jsonBody(sendCalls()[0]).text).toContain("not found");
  });
});

describe("handleSettingsCallback — chat-level", () => {
  it("settings:home re-renders the home view via editMessageText", async () => {
    const db = mockD1();
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

  it("settings:home:<page> re-renders the requested coin-button page", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_subscriptions",
        rows: ["usdt-tether", "usdc-circle", "dai-makerdao", "pyusd-paypal", "usds-sky", "usde-ethena"].map(
          subscriptionRow,
        ),
      },
    ]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:home:1",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "home",
      "1",
    );

    expect(editCalls().length).toBe(1);
    const body = jsonBody(editCalls()[0]) as {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> };
    };
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons.filter((button) => button.callback_data?.startsWith("settings:o:"))).toHaveLength(1);
    expect(buttons.some((button) => button.callback_data === "settings:home:0")).toBe(true);
    expect(ackCalls().length).toBe(1);
  });

  it("settings:gt:dews flips the global flag and re-renders", async () => {
    const db = mockD1();
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:gt:dews",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      },
      "gt",
      "dews",
    );

    const history = db.getHistory();
    const upsert = history.find(
      (h) =>
        /INSERT INTO telegram_subscribers/.test(h.sql) &&
        /global_alert_dews\s*=\s*excluded\.global_alert_dews/.test(h.sql),
    );
    expect(upsert).toBeDefined();
    // Binds are chatId, username, six per-coin flags, then six global flags.
    // global_alert_dews must be 1 (toggled from 0).
    expect(upsert!.binds[8]).toBe(1);
    expect(editCalls().length).toBe(1);
    expect(ackCalls().length).toBe(1);
    expect(jsonBody(ackCalls()[0]).text).toContain("dews");
  });

  it("settings:q:1 enables quiet hours with the default 22-07 window", async () => {
    const db = mockD1();
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

    const history = db.getHistory();
    const upsert = history.find(
      (h) =>
        /INSERT INTO telegram_subscribers/.test(h.sql) &&
        /quiet_hours_enabled = excluded\.quiet_hours_enabled/.test(h.sql),
    );
    expect(upsert).toBeDefined();
    // bind positions: chat_id, username, six per-coin flags, six global flags,
    //                 quiet_enabled(14), quiet_start(15), quiet_end(16)
    expect(upsert!.binds[14]).toBe(1);
    expect(upsert!.binds[15]).toBe(22);
    expect(upsert!.binds[16]).toBe(7);
    expect(ackCalls().length).toBe(1);
    expect(jsonBody(ackCalls()[0]).text).toContain("enabled");
  });

  it("settings:q:0 disables quiet hours", async () => {
    const db = mockD1();
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

    const upsert = db.getHistory().find((h) => /quiet_hours_enabled = excluded\.quiet_hours_enabled/.test(h.sql));
    expect(upsert).toBeDefined();
    expect(upsert!.binds[12]).toBe(0);
  });

  it("settings:sc clears the snooze timestamp", async () => {
    const db = mockD1();
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

    const upsert = db
      .getHistory()
      .find((h) => /INSERT INTO telegram_subscribers/.test(h.sql) && /alert_snooze_until_ts = NULL/.test(h.sql));
    expect(upsert).toBeDefined();
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

  it("settings:c:<id>:db:W sets DEWS min band to WARNING", async () => {
    const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:c:usdc-circle:db:W",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      },
      "c",
      "usdc-circle:db:W",
    );

    const history = db.getHistory();
    const insert = history.find(
      (h) => /INSERT INTO telegram_subscriptions/.test(h.sql) && /dews_min_band = excluded\.dews_min_band/.test(h.sql),
    );
    expect(insert).toBeDefined();
    expect(insert!.binds[1]).toBe("usdc-circle");
    expect(insert!.binds[2]).toBe(1); // alert_dews
    expect(insert!.binds[3]).toBe("WARNING");
    expect(jsonBody(ackCalls()[0]).text).toContain("WARNING");
  });

  it("settings:c:<id>:db:0 turns DEWS off without losing the row's other settings", async () => {
    const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:c:usdc-circle:db:0",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "c",
      "usdc-circle:db:0",
    );

    const insert = db.getHistory().find((h) => /alert_dews = excluded\.alert_dews/.test(h.sql));
    expect(insert).toBeDefined();
    expect(insert!.binds[2]).toBe(0);
  });

  it("settings:c:<id>:sm:d sets safety mode to downgrade-only", async () => {
    const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:c:usdc-circle:sm:d",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "c",
      "usdc-circle:sm:d",
    );

    const insert = db.getHistory().find((h) => /safety_mode = excluded\.safety_mode/.test(h.sql));
    expect(insert).toBeDefined();
    expect(insert!.binds[2]).toBe(1); // alert_safety
    expect(insert!.binds[3]).toBe("downgrade-only");
  });

  it("settings:c:<id>:ds:250 sets depeg-step to 250 bps", async () => {
    const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:c:usdc-circle:ds:250",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "c",
      "usdc-circle:ds:250",
    );

    const insert = db
      .getHistory()
      .find((h) => /depeg_worsening_bps_step = excluded\.depeg_worsening_bps_step/.test(h.sql));
    expect(insert).toBeDefined();
    expect(insert!.binds[2]).toBe(250);
  });

  it("settings:c:<id>:ds:0 clears depeg-step and disables depeg for the coin", async () => {
    const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:c:usdc-circle:ds:0",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "c",
      "usdc-circle:ds:0",
    );

    const insert = db
      .getHistory()
      .find(
        (h) =>
          /INSERT INTO telegram_subscriptions/.test(h.sql) &&
          /depeg_worsening_bps_step = CASE WHEN excluded\.alert_depeg = 0 THEN NULL/.test(h.sql),
      );
    expect(insert).toBeDefined();
    expect(insert!.binds[2]).toBe(0);
  });

  it("settings:c:<id>:lc:1 enables launch for the coin", async () => {
    const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:c:usdc-circle:lc:1",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "c",
      "usdc-circle:lc:1",
    );

    const insert = db
      .getHistory()
      .find(
        (h) => /INSERT INTO telegram_subscriptions/.test(h.sql) && /alert_launch = excluded\.alert_launch/.test(h.sql),
      );
    expect(insert).toBeDefined();
    expect(insert!.binds[2]).toBe(1);
  });

  it("unknown setting code under settings:c:<id>:?? acks gracefully without DB writes", async () => {
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

    const history = db.getHistory();
    expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(false);
    expect(jsonBody(ackCalls()[0]).text).toMatch(/unknown/i);
  });

  it("unknown coin id under settings:o acks gracefully", async () => {
    const db = mockD1([]);
    await handleSettingsCallback(
      db,
      "fake-token",
      {
        id: "cb",
        data: "settings:o:not-a-coin",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      },
      "o",
      "not-a-coin",
    );

    expect(editCalls().length).toBe(0);
    expect(jsonBody(ackCalls()[0]).text).toMatch(/unknown coin/i);
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
    expect(message).toContain("<b>Global alerts</b>\nDEWS: ON\nDepeg: ON (+25bps)\nSafety: OFF\nLaunch: ON\nReserve: ON\nFreeze: OFF\n");

    // Regression pin: the hand-written copy listed only DEWS/Depeg/Safety/Launch
    // while buildHomeKeyboard rendered a toggle row for all six, so a chat with
    // global Reserve or Freeze on saw the toggle but never the state line.
    const toggleLabels = buildHomeKeyboard(subscriber)
      .inline_keyboard.flat()
      .flatMap((button) => (button.callback_data?.startsWith("settings:gt:") ? [button.text.split(":")[0]!] : []));
    expect(toggleLabels).toHaveLength(6);
    for (const label of toggleLabels) {
      expect(message).toContain(`\n${label}: `);
    }
  });

  it("home message reflects active snooze duration", () => {
    const subscriber = {
      alert_dews: 0,
      alert_depeg: 0,
      alert_safety: 0,
      alert_launch: 0,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      alert_snooze_until_ts: Math.floor(Date.now() / 1000) + 3 * 3600,
    };
    expect(buildHomeMessage(subscriber)).toContain("Snooze: 3 h");
  });

  it("home message renders the Paused sentinel distinctly (not a multi-thousand-day countdown)", () => {
    const subscriber = {
      alert_dews: 0,
      alert_depeg: 0,
      alert_safety: 0,
      alert_launch: 0,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      alert_snooze_until_ts: PAUSE_SENTINEL_TS,
    };
    const message = buildHomeMessage(subscriber);
    expect(message).toContain("Snooze: Paused (indefinite)");
    expect(message).not.toMatch(/\d{3,} d/);
  });

  it("home keyboard shows Resume alerts when paused, Clear snooze otherwise", () => {
    const paused = buildHomeKeyboard({
      alert_dews: 0,
      alert_depeg: 0,
      alert_safety: 0,
      alert_launch: 0,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      alert_snooze_until_ts: PAUSE_SENTINEL_TS,
    });
    const pausedButtons = paused.inline_keyboard.flat();
    expect(pausedButtons.some((b) => b.text === "Resume alerts" && b.callback_data === "settings:sc")).toBe(true);
    expect(pausedButtons.some((b) => b.text === "Clear snooze")).toBe(false);

    const timed = buildHomeKeyboard({
      alert_dews: 0,
      alert_depeg: 0,
      alert_safety: 0,
      alert_launch: 0,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      alert_snooze_until_ts: Math.floor(Date.now() / 1000) + 3600,
    });
    const timedButtons = timed.inline_keyboard.flat();
    expect(timedButtons.some((b) => b.text === "Clear snooze" && b.callback_data === "settings:sc")).toBe(true);
    expect(timedButtons.some((b) => b.text === "Resume alerts")).toBe(false);
  });

  it("coin message reflects mixed enabled settings", () => {
    expect(
      buildCoinMessage("usdc-circle", {
        stablecoin_id: "usdc-circle",
        alert_dews: 1,
        alert_depeg: 1,
        alert_safety: 0,
        alert_launch: 0,
        dews_min_band: "WARNING",
        safety_mode: null,
        depeg_worsening_bps_step: 250,
      }),
    ).toContain("DEWS min band: WARNING");
  });
});
