import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 as baseMockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  createTelegramFetchSpy,
  lastSendMessageBody,
} from "../../test-helpers/telegram";
import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { resolveTicker } from "../../common/alerts-parser";
import type { WebhookCommandContext } from "../context";
import { handleHealth } from "../health";
import { handleMute } from "../mute";
import { handleSet } from "../set";
import { handleStart } from "../start";
import { handleSubscribe } from "../subscribe";
import { handleTimezone } from "../timezone";
import { handleUnmuteHours } from "../unmutehours";
import { handleUnsnooze } from "../unsnooze";
import { handleUnsubscribe } from "../unsubscribe";

import { makeCommandContext, buttonsFromMarkup, expectMiniAppButton, type InlineButton } from "./webhook-commands.test-support.ts";

type TelegramSendBody = {
  text?: string;
  reply_markup?: { inline_keyboard?: InlineButton[][] };
};

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();
const fixtures = createLatestSchemaFixtureTracker();

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
): MockD1Database {
  return baseMockD1([
    ...tables,
    { match: "FROM telegram_subscribers", rows: [], first: null },
    { match: "FROM telegram_subscriptions", rows: [] },
    { match: "FROM telegram_pending_disambiguation", rows: [], first: null },
    { match: "FROM telegram_recap_preferences", rows: [], first: null },
    { match: "FROM telegram_recap_targets", rows: [], first: null },
    { match: "INSERT INTO telegram_subscribers", rows: [] },
    { match: "UPDATE telegram_subscribers", rows: [] },
    { match: "INSERT INTO telegram_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
    { match: "INSERT INTO telegram_usage_daily", rows: [] },
    { match: "INSERT INTO cache", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  ], options);
}

function makeContext(overrides: Partial<WebhookCommandContext> = {}): WebhookCommandContext {
  return makeCommandContext(mockD1(), overrides);
}

function latestSendMessageBody(): TelegramSendBody {
  return lastSendMessageBody(fetchSpy);
}


function buttonsFromBody(body: TelegramSendBody): InlineButton[] {
  return buttonsFromMarkup(body.reply_markup);
}


function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    stablecoin_id: "usdc-circle",
    alert_dews: 1,
    alert_depeg: 0,
    alert_safety: 0,
    alert_launch: 0,
    dews_min_band: null,
    safety_mode: null,
    depeg_worsening_bps_step: null,
    ...overrides,
  };
}

function subscriberRow(overrides: Record<string, unknown> = {}) {
  return {
    alert_dews: 0,
    alert_depeg: 0,
    alert_safety: 0,
    alert_launch: 0,
    alert_reserve: 0,
    global_alert_dews: 0,
    global_alert_depeg: 0,
    global_alert_safety: 0,
    global_alert_launch: 0,
    global_alert_reserve: 0,
    global_depeg_worsening_bps_step: null,
    quiet_hours_enabled: 0,
    quiet_hours_start_utc: null,
    quiet_hours_end_utc: null,
    timezone: null,
    alert_snooze_until_ts: null,
    consecutive_block_count: 0,
    consecutive_block_first_at: null,
    ...overrides,
  };
}

describe("webhook command handlers", () => {
  beforeEach(() => {
    resetTelegramFetchSpy();
  });

  afterEach(() => {
    fixtures.closeAll();
  });

  it("handles /subscribe happy path with unique ticker", async () => {
    const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [subscriptionRow()] }]);
    const ctx = makeContext({ db });

    await handleSubscribe(ctx, "dews USDC");

    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_subscriptions") &&
            entry.binds[0] === "42" &&
            entry.binds[1] === "usdc-circle" &&
            entry.binds[2] === 1,
        ),
    ).toBe(true);
    const body = latestSendMessageBody();
    expect(body.text).toContain("Updated subscriptions");
    expect(body.text).toContain("USDC (usdc-circle)");
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_pending_disambiguation")
            && entry.binds.includes("confirm-bulk"),
        ),
    ).toBe(false);
  });

  it("handles /subscribe with unknown ticker", async () => {
    const db = mockD1();
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChat });

    await handleSubscribe(ctx, "dews XYZZY");

    expect(replyToChat).toHaveBeenCalledWith(expect.stringContaining("Ticker"));
    expect(replyToChat).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(replyToChat).toHaveBeenCalledWith(expect.stringContaining("/presets"));
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
  });

  it("handles /subscribe launch for a pre-launch ticker and includes Launch in the summary", async () => {
    const launchTarget = resolveTicker("USDPT");
    if (launchTarget.status !== "unique") {
      throw new Error("Expected USDPT to resolve uniquely for launch subscription test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_subscriptions",
        rows: [
          subscriptionRow({
            stablecoin_id: launchTarget.matches[0].id,
            alert_dews: 0,
            alert_launch: 1,
          }),
        ],
      },
    ]);
    const ctx = makeContext({ db });

    await handleSubscribe(ctx, "launch USDPT");

    const history = db.getHistory();
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_subscriptions") && entry.binds[1] === launchTarget.matches[0].id,
      ),
    ).toBe(true);
    const subscriptionsQuery = history.find((entry) => entry.sql.includes("FROM telegram_subscriptions"));
    expect(subscriptionsQuery?.sql).toContain("alert_launch");
    const body = latestSendMessageBody();
    expect(body.text).toContain("Launch");
    expect(body.text).toContain("USDPT");
  });

  it("gates /subscribe ... all behind a confirmation prompt", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at)
      VALUES ('42', 1, 1)`);
    const subscribersBefore = sqlite.prepare("SELECT * FROM telegram_subscribers").all();
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleSubscribe(ctx, "dews safety all");

    expect(sqlite.prepare("SELECT * FROM telegram_subscribers").all()).toEqual(subscribersBefore);
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual([]);
    const pendingRow = sqlite.prepare(
      "SELECT action_type, action_payload FROM telegram_pending_disambiguation WHERE chat_id = '42'",
    ).get() as { action_type: string; action_payload: string };
    expect(pendingRow.action_type).toBe("confirm-bulk");
    const pending = JSON.parse(pendingRow.action_payload) as { coinIds: string[]; presetIds: string[] };
    expect(pending.coinIds).toEqual([]);
    expect(pending.presetIds).toEqual([]);
    expect(replyToChatWithMarkup).toHaveBeenCalledTimes(1);
    const [message, options] = replyToChatWithMarkup.mock.calls[0]!;
    expect(message).toContain("Confirm?");
    expect(message).toMatch(/subscribe \d+ coins/);
    const buttons = buttonsFromMarkup(options.replyMarkup);
    expect(buttons).toEqual([
      { text: "Confirm", callback_data: "confirm:bulk" },
      { text: "Cancel", callback_data: "cancel:bulk" },
    ]);
  });

  it("/unsubscribe removes a direct coin follow", async () => {
    const db = mockD1();
    const ctx = makeContext({ db });

    await handleUnsubscribe(ctx, "USDC");

    const remove = db.getHistory().find((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"));
    expect(remove?.binds).toEqual(["42", "usdc-circle"]);
    expect(latestSendMessageBody().text).toContain("Removed 1 coin subscription");
  });

  it("/set updates per-coin settings and uses the canonical contextual Mini App label", async () => {
    const db = mockD1([
      { match: "FROM telegram_subscriptions", rows: [subscriptionRow({ dews_min_band: "WARNING" })] },
    ]);
    const ctx = makeContext({ db });

    await handleSet(ctx, "USDC dews WARNING");

    expect(
      db
        .getHistory()
        .some(
          (entry) => entry.sql.includes("dews_min_band = excluded.dews_min_band") && entry.binds.includes("WARNING"),
        ),
    ).toBe(true);
    const body = latestSendMessageBody();
    expect(body.text).toContain("Updated settings");
    expect(body.text).toContain("DEWS&gt;=WARNING");
    expectMiniAppButton(buttonsFromBody(body), "Open in app", "coin_usdc-circle");
  });

  it.each([
    {
      name: "handles /set all for global alert flags",
      args: "all depeg off",
      subscriber: subscriberRow({ global_alert_depeg: 0 }),
      sql: ["global_alert_depeg = excluded.global_alert_depeg"],
      step: null,
    },
    {
      name: "handles /set all depeg-step for global worsening alerts",
      args: "all depeg-step 250",
      subscriber: subscriberRow({ global_alert_depeg: 1, global_depeg_worsening_bps_step: 250 }),
      sql: ["global_alert_depeg", "global_depeg_worsening_bps_step = ?"],
      step: 250,
    },
  ])("$name", async ({ args, subscriber, sql, step }) => {
    const db = mockD1([{ match: "FROM telegram_subscribers", rows: [], first: subscriber }]);
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleSet(ctx, args);

    const history = db.getHistory();
    for (const fragment of sql) {
      expect(history.some((entry) => entry.sql.includes(fragment))).toBe(true);
    }
    if (step !== null) expect(history.some((entry) => entry.binds.includes(step))).toBe(true);
    expect(replyToChatWithMarkup).toHaveBeenCalledTimes(1);
    const [message, options] = replyToChatWithMarkup.mock.calls[0]!;
    expect(message).toContain("Updated all-stablecoin alerts");
    if (step !== null) expect(message).toContain("Depeg +250bps");
    expectMiniAppButton(buttonsFromMarkup(options.replyMarkup), "Open in app", "watchlist");
  });

  it("/timezone persists a valid zone and hides quick-pick keyboards in groups", async () => {
    const db = mockD1();
    const privateReplyWithMarkup = vi.fn().mockResolvedValue(undefined);
    const privateCtx = makeContext({ db, replyToChatWithMarkup: privateReplyWithMarkup });

    await handleTimezone(privateCtx, "Europe/Paris");

    expect(
      db
        .getHistory()
        .some((entry) => entry.sql.includes("timezone = excluded.timezone") && entry.binds.includes("Europe/Paris")),
    ).toBe(true);
    const [, privateOptions] = privateReplyWithMarkup.mock.calls[0]!;
    expect(privateReplyWithMarkup.mock.calls[0]![0]).toContain("Timezone set to Europe/Paris");
    expectMiniAppButton(buttonsFromMarkup(privateOptions.replyMarkup), "Open in app", "quiet-hours");

    const groupReply = vi.fn().mockResolvedValue(undefined);
    const groupReplyWithMarkup = vi.fn().mockResolvedValue(undefined);
    const groupDb = mockD1([
      { match: "FROM telegram_subscribers", rows: [], first: subscriberRow({ timezone: "UTC" }) },
    ]);
    const groupCtx = makeContext({
      db: groupDb,
      chatType: "supergroup",
      replyToChat: groupReply,
      replyToChatWithMarkup: groupReplyWithMarkup,
    });

    await handleTimezone(groupCtx, "");

    expect(groupReplyWithMarkup).not.toHaveBeenCalled();
    expect(groupReply).toHaveBeenCalledTimes(1);
    expect(groupReply.mock.calls[0]![0]).toContain("Ask a group admin");
    expect(groupReply.mock.calls[0]![0]).not.toContain("keyboard");
  });

  it("/timezone rejects unknown zones without writing to D1", async () => {
    const db = mockD1();
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChat });

    await handleTimezone(ctx, "Mars/Olympus_Mons");

    const wrote = db
      .getHistory()
      .some((entry) => entry.sql.includes("INSERT INTO telegram_subscribers") && entry.binds.includes("Mars/Olympus_Mons"));
    expect(wrote).toBe(false);
    expect(replyToChat).toHaveBeenCalledWith(expect.stringContaining("Unknown timezone"));
  });

  it("/mute, /unmutehours, and /unsnooze write state and use the contextual Mini App label", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers (
      chat_id, created_at, last_active_at, alert_dews, alert_depeg, alert_safety, alert_launch,
      global_alert_safety, alert_snooze_until_ts
    ) VALUES ('42', 1, 1, 1, 1, 1, 1, 1, 123)`);
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleMute(ctx, "22-07");
    expect(sqlite.prepare(`SELECT alert_dews, alert_depeg, alert_safety, alert_launch, global_alert_safety,
      quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc
      FROM telegram_subscribers WHERE chat_id = '42'`).get()).toEqual({
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 1,
      alert_launch: 1,
      global_alert_safety: 1,
      quiet_hours_enabled: 1,
      quiet_hours_start_utc: 22,
      quiet_hours_end_utc: 7,
    });
    expect(replyToChatWithMarkup.mock.calls[0]![0]).toContain("Quiet hours enabled");
    expect(replyToChatWithMarkup.mock.calls[0]![0]).toContain("22:00–07:00 UTC");
    await handleUnmuteHours(ctx, "");
    expect(sqlite.prepare("SELECT quiet_hours_enabled FROM telegram_subscribers WHERE chat_id = '42'").get())
      .toEqual({ quiet_hours_enabled: 0 });
    await handleUnsnooze(ctx, "");
    expect(sqlite.prepare("SELECT alert_snooze_until_ts FROM telegram_subscribers WHERE chat_id = '42'").get())
      .toEqual({ alert_snooze_until_ts: null });
    expect(replyToChatWithMarkup.mock.calls[2]![0]).toContain("Alert snooze cleared");
    for (const [, options] of replyToChatWithMarkup.mock.calls) {
      const buttons = buttonsFromMarkup(options.replyMarkup);
      expect(buttons.some((button) => button.text === "Open in app" && button.web_app?.url)).toBe(true);
    }
    const payloads = replyToChatWithMarkup.mock.calls.map(
      ([, options]) => buttonsFromMarkup(options.replyMarkup)[0]?.web_app?.url ?? "",
    );
    expect(payloads.some((url) => url.includes("startapp=quiet-hours"))).toBe(true);
    expect(payloads.some((url) => url.includes("startapp=snooze"))).toBe(true);
  });

  it("/start exposes the control-panel entry and the setup wizard branch keyboard", async () => {
    const appReplyWithMarkup = vi.fn().mockResolvedValue(undefined);
    const appCtx = makeContext({ replyToChatWithMarkup: appReplyWithMarkup });

    await handleStart(appCtx, "app");

    const [, appOptions] = appReplyWithMarkup.mock.calls[0]!;
    expectMiniAppButton(buttonsFromMarkup(appOptions.replyMarkup), "Open control panel", "home");

    const db = mockD1();
    const wizardCtx = makeContext({ db });
    await handleStart(wizardCtx, "");

    const pendingInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(pendingInsert?.binds).toContain("setup-step");
    const body = latestSendMessageBody();
    const callbacks = buttonsFromBody(body).map((button) => button.callback_data);
    expect(callbacks).toEqual(
      expect.arrayContaining(["setup:branch:recommended", "setup:branch:custom", "setup:branch:skip"]),
    );
    expectMiniAppButton(buttonsFromBody(body), "Open control panel", "watchlist");
  });

  it.each([
    {
      name: "/health renders delivery diagnostics and opens the contextual app view",
      subscriber: subscriberRow({
        quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7, global_alert_reserve: 1,
      }),
      activeCount: 2, pendingCount: 1, lastError: { last_error_class: "rate_limit" }, now: null,
      contains: ["Bot Health", "Queued alerts for this chat: 1", "Recent failure class: rate_limit",
        "Alert readiness: 2 explicit coin follows", "global: Reserve"],
      excludes: [], notMatch: null, diagnostics: true,
    },
    {
      name: "/health evaluates active quiet hours in the saved timezone",
      subscriber: subscriberRow({
        quiet_hours_enabled: 1, quiet_hours_start_utc: 13, quiet_hours_end_utc: 14, timezone: "Europe/Paris",
      }),
      activeCount: 0, pendingCount: 0, lastError: null, now: Date.UTC(2024, 0, 15, 12, 0, 0),
      contains: ["Quiet hours: 13:00–14:00 Europe/Paris (active now)"],
      excludes: ["13:00–14:00 UTC"], notMatch: null, diagnostics: false,
    },
    {
      name: "/health renders the Paused sentinel distinctly",
      subscriber: subscriberRow({ alert_snooze_until_ts: PAUSE_SENTINEL_TS }),
      activeCount: 0, pendingCount: 0, lastError: null, now: null,
      contains: ["Snooze: Paused (indefinite)"],
      excludes: [], notMatch: /Snooze: Active for \d+ d/, diagnostics: false,
    },
  ])("$name", async ({ subscriber, activeCount, pendingCount, lastError, now, contains, excludes, notMatch, diagnostics }) => {
    const nowSpy = now === null ? null : vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const db = mockD1([
        { match: "FROM telegram_subscribers", rows: [], first: subscriber },
        { match: "FROM telegram_preset_subscriptions", rows: [] },
        { match: "COUNT(*) AS active_count", rows: [], first: { active_count: activeCount } },
        { match: "COUNT(*) AS pending_count", rows: [], first: { pending_count: pendingCount } },
        { match: "SELECT last_error_class", rows: [], first: lastError },
        { match: "FROM telegram_chat_delivery_diagnostics", rows: [], first: null },
      ]);
      const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ db, replyToChatWithMarkup });

      await handleHealth(ctx, "");

      const [message, options] = replyToChatWithMarkup.mock.calls[0]!;
      for (const text of contains) expect(message).toContain(text);
      for (const text of excludes) expect(message).not.toContain(text);
      if (notMatch) expect(message).not.toMatch(notMatch);
      if (diagnostics) {
        expect(replyToChatWithMarkup).toHaveBeenCalledTimes(1);
        const activeCountQuery = db.getHistory().find((entry) => entry.sql.includes("COUNT(*) AS active_count"));
        expect(activeCountQuery?.sql).toContain("OR alert_reserve = 1");
        expectMiniAppButton(buttonsFromMarkup(options.replyMarkup), "Open in app", "health");
      }
    } finally {
      nowSpy?.mockRestore();
    }
  });

  it("mutating command handlers keep DB writes on their own chat id", async () => {
    const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [subscriptionRow()] }]) as MockD1Database;
    const ctx = makeContext({ db, chatId: "9001" });

    await handleSubscribe(ctx, "dews USDC");

    expect(
      db
        .getHistory()
        .some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions") && entry.binds[0] === "9001"),
    ).toBe(true);
  });
});
