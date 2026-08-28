import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 as baseMockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import {
  createTelegramFetchSpy,
  lastSendMessageBody,
} from "../../../test-helpers/__shared/telegram";
import { PAUSE_SENTINEL_TS } from "../../../lib/telegram-constants";
import type { WebhookCommandContext } from "../context";
import { handleCancel } from "../cancel";
import { handleHealth } from "../health";
import { handleList } from "../list";
import { handleMute } from "../mute";
import { handleSet } from "../set";
import { handleSettings } from "../settings";
import { handleStart } from "../start";
import { handleSubscribe } from "../subscribe";
import { handleTimezone } from "../timezone";
import { handleUnmuteHours } from "../unmutehours";
import { handleUnsnooze } from "../unsnooze";
import { handleUnsubscribe } from "../unsubscribe";

type InlineButton = {
  text?: string;
  callback_data?: string;
  web_app?: { url?: string };
};

type TelegramSendBody = {
  text?: string;
  reply_markup?: { inline_keyboard?: InlineButton[][] };
};

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();

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
  return {
    db: mockD1(),
    chatId: "42",
    chatType: "private",
    username: "alice",
    actorUserId: "99",
    botToken: "bot-token",
    replyToChat: vi.fn().mockResolvedValue(undefined),
    replyToChatWithMarkup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function latestSendMessageBody(): TelegramSendBody {
  return lastSendMessageBody(fetchSpy);
}

function buttonsFromMarkup(markup: unknown): InlineButton[] {
  const typed = markup as { inline_keyboard?: InlineButton[][] } | undefined;
  return (typed?.inline_keyboard ?? []).flat();
}

function buttonsFromBody(body: TelegramSendBody): InlineButton[] {
  return buttonsFromMarkup(body.reply_markup);
}

function expectMiniAppButton(buttons: InlineButton[], text: string, startapp: string): void {
  expect(buttons.some((button) => button.text === text && button.web_app?.url?.includes(`startapp=${startapp}`))).toBe(
    true,
  );
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

  it("/subscribe persists a direct coin follow and returns a subscription summary", async () => {
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
  });

  it("/subscribe all stores a pending bulk confirmation instead of mutating subscriptions", async () => {
    const db = mockD1();
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleSubscribe(ctx, "dews all");

    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    const pendingInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(pendingInsert?.binds).toContain("confirm-bulk");
    expect(replyToChatWithMarkup).toHaveBeenCalledTimes(1);
    const [message, options] = replyToChatWithMarkup.mock.calls[0]!;
    expect(message).toContain("Confirm?");
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
    expectMiniAppButton(buttonsFromBody(body), "Open in app", "coin_usdc-circle");
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

  it("/mute, /unmutehours, and /unsnooze write state and use the contextual Mini App label", async () => {
    const db = mockD1();
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleMute(ctx, "22-07");
    await handleUnmuteHours(ctx, "");
    await handleUnsnooze(ctx, "");

    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("quiet_hours_enabled = excluded.quiet_hours_enabled") &&
            entry.binds.includes(22) &&
            entry.binds.includes(7),
        ),
    ).toBe(true);
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("quiet_hours_enabled = excluded.quiet_hours_enabled") && entry.binds.includes(0),
        ),
    ).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("alert_snooze_until_ts = NULL"))).toBe(true);
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

  it("/settings sends editable settings controls with a canonical Mini App label", async () => {
    const db = mockD1([{ match: "FROM telegram_subscribers", rows: [], first: null }]);
    const ctx = makeContext({ db });

    await handleSettings(ctx, "");

    const body = latestSendMessageBody();
    expect(body.text).toContain("<b>Settings</b>");
    const buttons = buttonsFromBody(body);
    expect(buttons.map((button) => button.callback_data)).toEqual(
      expect.arrayContaining(["settings:gt:dews", "settings:gt:depeg"]),
    );
    expectMiniAppButton(buttons, "Open in app", "settings");
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

  it("/start sample runs the synthetic preview in private chats", async () => {
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ chatType: "private", replyToChat });

    await handleStart(ctx, "sample");

    expect(replyToChat).toHaveBeenCalledTimes(1);
    const message = replyToChat.mock.calls[0]![0] as string;
    expect(message).toContain("sample alert");
    expect(message).toContain("USDC");
  });

  it("/start sample does not run the preview in groups", async () => {
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ chatType: "group", replyToChat });

    await handleStart(ctx, "sample");

    expect(replyToChat).toHaveBeenCalledTimes(1);
    const message = replyToChat.mock.calls[0]![0] as string;
    expect(message).not.toContain("sample alert");
  });

  it("/health renders delivery diagnostics and opens the contextual app view", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: subscriberRow({
          quiet_hours_enabled: 1,
          quiet_hours_start_utc: 22,
          quiet_hours_end_utc: 7,
          global_alert_reserve: 1,
        }),
      },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "COUNT(*) AS active_count", rows: [], first: { active_count: 2 } },
      { match: "COUNT(*) AS pending_count", rows: [], first: { pending_count: 1 } },
      { match: "SELECT last_error_class", rows: [], first: { last_error_class: "rate_limit" } },
      { match: "FROM telegram_chat_delivery_diagnostics", rows: [], first: null },
    ]);
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleHealth(ctx, "");

    expect(replyToChatWithMarkup).toHaveBeenCalledTimes(1);
    const [message, options] = replyToChatWithMarkup.mock.calls[0]!;
    expect(message).toContain("Bot Health");
    expect(message).toContain("Queued alerts for this chat: 1");
    expect(message).toContain("Recent failure class: rate_limit");
    expect(message).toContain("Alert readiness: 2 explicit coin follows");
    expect(message).toContain("global: Reserve");
    const activeCountQuery = db.getHistory().find((entry) => entry.sql.includes("COUNT(*) AS active_count"));
    expect(activeCountQuery?.sql).toContain("OR alert_reserve = 1");
    expectMiniAppButton(buttonsFromMarkup(options.replyMarkup), "Open in app", "health");
  });

  it("/health evaluates active quiet hours in the saved timezone", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2024, 0, 15, 12, 0, 0));
    try {
      const db = mockD1([
        {
          match: "FROM telegram_subscribers",
          rows: [],
          first: subscriberRow({
            quiet_hours_enabled: 1,
            quiet_hours_start_utc: 13,
            quiet_hours_end_utc: 14,
            timezone: "Europe/Paris",
          }),
        },
        { match: "FROM telegram_preset_subscriptions", rows: [] },
        { match: "COUNT(*) AS active_count", rows: [], first: { active_count: 0 } },
        { match: "COUNT(*) AS pending_count", rows: [], first: { pending_count: 0 } },
        { match: "SELECT last_error_class", rows: [], first: null },
        { match: "FROM telegram_chat_delivery_diagnostics", rows: [], first: null },
      ]);
      const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ db, replyToChatWithMarkup });

      await handleHealth(ctx, "");

      const [message] = replyToChatWithMarkup.mock.calls[0]!;
      expect(message).toContain("Quiet hours: 13:00–14:00 Europe/Paris (active now)");
      expect(message).not.toContain("13:00–14:00 UTC");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("/health renders the Paused sentinel distinctly", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: subscriberRow({ alert_snooze_until_ts: PAUSE_SENTINEL_TS }),
      },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "COUNT(*) AS active_count", rows: [], first: { active_count: 0 } },
      { match: "COUNT(*) AS pending_count", rows: [], first: { pending_count: 0 } },
      { match: "SELECT last_error_class", rows: [], first: null },
      { match: "FROM telegram_chat_delivery_diagnostics", rows: [], first: null },
    ]);
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleHealth(ctx, "");

    const [message] = replyToChatWithMarkup.mock.calls[0]!;
    expect(message).toContain("Snooze: Paused (indefinite)");
    expect(message).not.toMatch(/Snooze: Active for \d+ d/);
  });

  it("/list empty private chats offers both the control panel and preset discovery", async () => {
    const db = mockD1([
      { match: "FROM telegram_subscribers", rows: [], first: null },
      { match: "FROM telegram_subscriptions", rows: [] },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
    ]);
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleList(ctx, "");

    const [message, options] = replyToChatWithMarkup.mock.calls[0]!;
    expect(message).toContain("No active subscriptions");
    const buttons = buttonsFromMarkup(options.replyMarkup);
    expectMiniAppButton(buttons, "Open control panel", "watchlist");
    expectMiniAppButton(buttons, "Browse presets", "presets");
  });

  it("/list loads per-coin snooze state for subscription summaries", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "FROM telegram_subscribers", rows: [], first: subscriberRow() },
      {
        match: "FROM telegram_subscriptions",
        rows: [subscriptionRow({ alert_snooze_until_ts: nowSec + 2 * 3600 })],
      },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
    ]);
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleList(ctx, "");

    const subscriptionSelect = db.getHistory().find((entry) => entry.sql.includes("FROM telegram_subscriptions"));
    expect(subscriptionSelect?.sql).toContain("alert_snooze_until_ts");
    const [message] = replyToChatWithMarkup.mock.calls[0]!;
    expect(message).toContain("USDC (usdc-circle): DEWS · per-coin — snoozed for 2 h");
  });

  it("/cancel without pending state gives recovery commands", async () => {
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ replyToChat });

    await handleCancel(ctx, "");

    expect(replyToChat).toHaveBeenCalledWith(expect.stringContaining("/start"));
    expect(replyToChat).toHaveBeenCalledWith(expect.stringContaining("/list"));
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
