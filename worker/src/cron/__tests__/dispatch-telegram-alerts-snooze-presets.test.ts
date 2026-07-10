import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockGetCache,
  mockSetCache,
  STABLECOINS_CACHE_WITH_USDC,
  mockRecordOutcome,
  mockSendToChat,
  mockSendBatch,
  dispatchTelegramAlerts,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  makeSafetySourceCache,
  makeSafetySnapshotCache,
  parseLogRecords,
  resetDispatchTelegramAlertsTest,
  cleanupDispatchTelegramAlertsTest,
  fixtureMockD1,
} from "./dispatch-telegram-alerts.test-support";
import { ALERT_RESERVE_SOURCE_GENERATION } from "../../lib/alert-reserve-source-cache";

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);
  it("attaches snooze inline keyboard to every fresh subscriber alert", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", rows: [{ stablecoin_id: "usdc-circle", chat_id: "42", last_active_at: now }] },
      { match: "WHERE global_alert_dews = 1", rows: [] },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    await dispatchTelegramAlerts(db, "bot-token");

    // sendBatch is mocked at file scope — inspect the BatchMessage array for the
    // per-message replyMarkup. The third positional is the batch size.
    const calls = mockSendBatch.mock.calls;
    const lastCall = calls[calls.length - 1];
    const messages = lastCall?.[0] as Array<{
      replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    }>;
    const callbackData = messages?.[0]?.replyMarkup?.inline_keyboard?.flat().map((button) => button.callback_data);
    expect(callbackData).toContain("status:usdc-circle");
    expect(callbackData).toContain("snooze:4h");
    // P1-U10: compact per-coin snooze control on single-coin alerts.
    expect(callbackData).toContain("coinsnooze:usdc-circle:4h");
    expect(messages?.[0]?.replyMarkup?.inline_keyboard?.length).toBeLessThanOrEqual(2);
  });

  it("attaches link_preview_options to the first chunk of single-coin alerts", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", rows: [{ stablecoin_id: "usdc-circle", chat_id: "42", last_active_at: now }] },
      { match: "WHERE global_alert_dews = 1", rows: [] },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    await dispatchTelegramAlerts(db, "bot-token");

    const lastCall = mockSendBatch.mock.calls[mockSendBatch.mock.calls.length - 1];
    const messages = lastCall?.[0] as Array<{
      chunkIndex?: number;
      linkPreviewOptions?: { is_disabled: boolean; url: string; prefer_small_media: boolean; show_above_text: boolean };
    }>;
    expect(messages?.[0]?.linkPreviewOptions).toEqual({
      is_disabled: false,
      url: "https://pharos.watch/stablecoin/usdc-circle",
      prefer_small_media: true,
      show_above_text: false,
    });
  });

  it("skips a chat whose alert_snooze_until_ts is in the future and reports chatsWithActiveSnooze", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    // Chat A is snoozed; chat B is not. Only B should receive the DEWS alert.
    const db = fixtureMockD1([
      {
        match: "WHERE alert_snooze_until_ts IS NOT NULL",
        rows: [{ chat_id: "A" }],
      },
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [
          {
            chat_id: "B",
            last_active_at: now,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 60 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      messagesSent: number;
      chatsWithActiveSnooze: number;
    };

    expect(metadata.messagesSent).toBe(1);
    expect(metadata.chatsWithActiveSnooze).toBe(1);
  });

  it("skips a global subscriber for a coin with an active per-coin snooze (P1-U10)", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    // Chat C is a global DEWS subscriber AND has a per-coin snooze on usdc-circle.
    // The dispatcher must respect the per-coin snooze and skip the alert for C.
    const db = fixtureMockD1([
      { match: "FROM telegram_subscribers\n        WHERE alert_snooze_until_ts", rows: [] },
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      // Per-coin snooze map query (loadPerCoinSnoozeMap): chat C is snoozed for usdc-circle.
      {
        match: "FROM telegram_subscriptions\n          WHERE stablecoin_id IN",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "C" }],
      },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [
          {
            chat_id: "C",
            last_active_at: now,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 60 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { messagesSent: number };

    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("deduplicates 403 cleanup for a chat hit across multiple alert types", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 403,
      errorClass: "blocked",
      delivery: "blocked",
      retryAfterSec: null,
    });

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    // One subscriber (42) who global-subscribes to DEWS and depeg.
    // Both alert types fire; we should only clean them up ONCE.
    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [
          {
            chat_id: "42",
            last_active_at: now,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 60 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { blockedUsersCleanedUp: number };

    // Even though chat 42 may produce multiple routable events in some scenarios,
    // the blocked-cleanup counter reports exactly one cleanup.
    expect(metadata.blockedUsersCleanedUp).toBe(1);
  });

  it("degrades preset delivery when the preset-subscribers query fails but still sends direct/global alerts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "telegram:preset-query-failure-count") {
        return null;
      }
      if (key === "stablecoins") {
        return { value: STABLECOINS_CACHE_WITH_USDC, updatedAt: now - 60 };
      }
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "SELECT source_event_id, page_key, alert_type, page_index",
        rows: [{
          source_event_id: "test-source",
          page_key: "dews:0",
          alert_type: "dews",
          page_index: 0,
          cursor_chat_id: null,
          cursor_preset_id: null,
          memberships_resolved: 0,
          status: "pending",
          attempt_count: 0,
        }],
      },
      { match: "SELECT COUNT(*) AS count\n         FROM telegram_alert_source_resolution_pages", rows: [{ count: 1 }] },
      { match: "SELECT DISTINCT alert_type\n           FROM telegram_alert_source_resolution_pages", rows: [{ alert_type: "dews" }] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      // Preset query fails for every alert type.
      { match: "FROM telegram_preset_subscriptions p", throwError: new Error("D1_ERROR: connection reset"), rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    try {
      const result = await dispatchTelegramAlerts(db, "bot-token");
      const metadata = JSON.parse(result.metadata) as {
        presetQueryFailures: number;
        presetResolutionFailures: number;
        presetFailure: boolean;
        snapshotSeeded: boolean;
        subscribersNotified: number;
        messagesSent: number;
      };

      expect(metadata.presetFailure).toBe(true);
      expect(metadata.presetQueryFailures).toBeGreaterThanOrEqual(1);
      expect(metadata.presetResolutionFailures).toBe(0);
      expect(metadata.snapshotSeeded).toBe(false);
      expect(metadata.subscribersNotified).toBe(1);
      expect(metadata.messagesSent).toBe(1);
      expect(mockSendToChat).toHaveBeenCalledTimes(1);

      const presetQueryLog = parseLogRecords(warnSpy).find((record) => record.action === "preset-query");
      expect(presetQueryLog).toMatchObject({
        scope: "telegram",
        level: "warn",
        module: "telegram-alert-source-events",
        failureKind: "query-failed",
        alertType: "dews",
        requestedStablecoinCount: 1,
        err: "D1_ERROR: connection reset",
      });

      const snapshotWrites = mockSetCache.mock.calls.filter(
        ([_db, key]) => typeof key === "string" && key.startsWith("alert:"),
      );
      expect(snapshotWrites).toHaveLength(0);

      // The failure counter is persisted.
      const counterWrite = mockSetCache.mock.calls.find(([_db, key]) => key === "telegram:preset-query-failure-count");
      expect(counterWrite).toBeTruthy();
      expect(counterWrite?.[2]).toBe("1");

      // Preset failure no longer poisons the Telegram API circuit when direct
      // delivery succeeds.
      expect(mockRecordOutcome).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not resolve dynamic presets when no preset subscriber rows exist", async () => {
    const now = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "telegram:preset-query-failure-count") {
        return null;
      }
      if (key === "stablecoins") {
        return { value: STABLECOINS_CACHE_WITH_USDC, updatedAt: now - 60 };
      }
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "direct-chat", last_active_at: now }],
      },
      { match: "FROM telegram_preset_subscriptions p", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    try {
      const result = await dispatchTelegramAlerts(db, "bot-token");
      const metadata = JSON.parse(result.metadata) as {
        presetFailure: boolean;
        presetQueryFailures: number;
        presetResolutionFailures: number;
        subscribersNotified: number;
        messagesSent: number;
      };

      expect(metadata.presetFailure).toBe(false);
      expect(metadata.presetQueryFailures).toBe(0);
      expect(metadata.presetResolutionFailures).toBe(0);
      expect(metadata.subscribersNotified).toBe(1);
      expect(metadata.messagesSent).toBe(1);
      expect(mockSendToChat).toHaveBeenCalledTimes(1);
      expect(mockSendToChat.mock.calls[0]?.[0]).toBe("direct-chat");

      expect(parseLogRecords(warnSpy).some((record) => record.action === "preset-resolution")).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("degrades preset delivery when dynamic preset resolution fails but keeps direct delivery", async () => {
    const now = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "telegram:preset-query-failure-count") {
        return null;
      }
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "SELECT source_event_id, page_key, alert_type, page_index",
        rows: [{
          source_event_id: "test-source",
          page_key: "dews:0",
          alert_type: "dews",
          page_index: 0,
          cursor_chat_id: null,
          cursor_preset_id: null,
          memberships_resolved: 0,
          status: "pending",
          attempt_count: 0,
        }],
      },
      { match: "SELECT COUNT(*) AS count\n         FROM telegram_alert_source_resolution_pages", rows: [{ count: 1 }] },
      { match: "SELECT DISTINCT alert_type\n           FROM telegram_alert_source_resolution_pages", rows: [{ alert_type: "dews" }] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "direct-chat", last_active_at: now }],
      },
      {
        match: "FROM telegram_preset_subscriptions p",
        rows: [
          {
            chat_id: "preset-chat",
            preset_id: "usd-top25",
            last_active_at: now,
            depeg_worsening_bps_step: null,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
            timezone: null,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    try {
      const result = await dispatchTelegramAlerts(db, "bot-token");
      const metadata = JSON.parse(result.metadata) as {
        presetFailure: boolean;
        presetQueryFailures: number;
        presetResolutionFailures: number;
        subscribersNotified: number;
        messagesSent: number;
      };

      expect(metadata.presetFailure).toBe(true);
      expect(metadata.presetQueryFailures).toBe(0);
      expect(metadata.presetResolutionFailures).toBe(1);
      expect(metadata.subscribersNotified).toBe(1);
      expect(metadata.messagesSent).toBe(1);
      expect(mockSendToChat).toHaveBeenCalledTimes(1);
      expect(mockSendToChat.mock.calls[0]?.[0]).toBe("direct-chat");

      const presetResolutionLog = parseLogRecords(warnSpy).find((record) => record.action === "preset-resolution");
      expect(presetResolutionLog).toMatchObject({
        scope: "telegram",
        level: "warn",
        module: "telegram-alert-source-events",
        failureKind: "resolution-failed",
        alertType: "dews",
        reason: "stablecoins-cache-unavailable",
        presetIds: expect.arrayContaining(["usd-top25"]),
        presetCount: 10,
        requestedStablecoinCount: 1,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("clears the preset-failure counter on a successful run", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "telegram:preset-query-failure-count") {
        return { value: "2", updatedAt: now - 60 };
      }
      if (key === "stablecoins") {
        return { value: STABLECOINS_CACHE_WITH_USDC, updatedAt: now - 60 };
      }
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      presetFailure: boolean;
      presetQueryFailures: number;
    };

    expect(metadata.presetFailure).toBe(false);
    expect(metadata.presetQueryFailures).toBe(0);

    const counterWrite = mockSetCache.mock.calls.find(([_db, key]) => key === "telegram:preset-query-failure-count");
    expect(counterWrite?.[2]).toBe("0");
  });
  it("attributes per-alert-type delivery stats by dominant category", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Subscriber A receives only a DEWS change → dominant = dews.
    // Subscriber C receives only a depeg trigger → dominant = depeg.
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:launch-snapshot") return { value: JSON.stringify([]), updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 125,
            start_price: 0.9875,
            peg_reference: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "A", last_active_at: now }],
      },
      {
        match: "sub.alert_depeg = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "C", last_active_at: now - 10 }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      perAlertType: Record<
        string,
        { sent: number; enqueued: number; failed: number; blocked: number; firstSendLatencyMs: number | null }
      >;
      messagesSent: number;
    };

    expect(metadata.messagesSent).toBe(2);
    expect(metadata.perAlertType.dews.sent).toBe(1);
    expect(metadata.perAlertType.depeg.sent).toBe(1);
    expect(metadata.perAlertType.safety.sent).toBe(0);
    expect(metadata.perAlertType.launch.sent).toBe(0);
    expect(metadata.perAlertType.dews.firstSendLatencyMs).not.toBeNull();
    expect(metadata.perAlertType.depeg.firstSendLatencyMs).not.toBeNull();
    expect(metadata.perAlertType.safety.firstSendLatencyMs).toBeNull();
    expect(metadata.perAlertType.launch.firstSendLatencyMs).toBeNull();
  });

  it("buckets blocked/failed/enqueued by alert type", async () => {
    const now = Math.floor(Date.now() / 1000);

    // One DEWS-only subscriber whose send returns blocked → blocked++.
    // One depeg-only subscriber whose send returns a permanent failure → failed++.
    mockSendBatch.mockResolvedValueOnce([
      {
        chatId: "A",
        ok: false,
        blocked: true,
        retryable: false,
        permanentFailure: true,
        statusCode: 403,
        errorClass: "blocked",
        delivery: "blocked",
        retryAfterSec: null,
      },
      {
        chatId: "B",
        ok: false,
        blocked: false,
        retryable: false,
        permanentFailure: true,
        statusCode: 400,
        errorClass: "permanent",
        delivery: "permanent_failure",
        retryAfterSec: null,
      },
    ]);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 125,
            start_price: 0.9875,
            peg_reference: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "A", last_active_at: now }],
      },
      {
        match: "sub.alert_depeg = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "B", last_active_at: now - 10 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      perAlertType: Record<
        string,
        { sent: number; enqueued: number; failed: number; blocked: number; firstSendLatencyMs: number | null }
      >;
    };

    expect(metadata.perAlertType.dews.blocked).toBe(1);
    expect(metadata.perAlertType.dews.sent).toBe(0);
    expect(metadata.perAlertType.depeg.failed).toBe(1);
    expect(metadata.perAlertType.depeg.sent).toBe(0);
  });

  it("chunks a 120-coin depeg fan-out for one chat and preserves overflow past the format budget", async () => {
    // P1-T2: a single chat subscribed to 120 stablecoins receives one
    // consolidated depeg message that splits into multiple chunks. Many
    // additional global subscribers push total chunk demand past the
    // MAX_MESSAGES_PER_RUN cap so overflow is preserved rather than being
    // dropped, while the heavy chat is still attempted.
    const now = Math.floor(Date.now() / 1000);

    // 120 distinct synthetic stablecoin ids. They do not need to be in the
    // tracked registry — getSymbol falls back to the id when unknown.
    const stablecoinIds = Array.from({ length: 120 }, (_, i) => `scale-depeg-${i.toString().padStart(3, "0")}`);

    const depegRows = stablecoinIds.map((id, i) => ({
      stablecoin_id: id,
      symbol: `SD${i}`,
      direction: "below",
      peak_deviation_bps: 150 + (i % 50),
      start_price: 0.985,
      peg_reference: 1,
    }));

    // One mega-subscribed chat owns rows for all 120 ids; depeg subscriptions
    // are looked up via a single batched query.
    const megaChatId = "mega-chat";
    const directDepegRows = stablecoinIds.map((id) => ({
      stablecoin_id: id,
      chat_id: megaChatId,
      last_active_at: now,
      depeg_worsening_bps_step: null,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
    }));

    // Extra global subscribers — each receives the same consolidated 120-coin
    // message. The fixture is sized to exceed the current fresh-send cap.
    const globalDepegRows = Array.from({ length: 1250 }, (_, i) => ({
      chat_id: `global-${i}`,
      last_active_at: now - 1000 - i, // older than megaChatId so mega is sent first
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      global_depeg_worsening_bps_step: null,
    }));

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      // Empty depeg snapshot ⇒ every active depeg row is a fresh trigger.
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: depegRows },
      { match: "FROM safety_grade_history", rows: [] },
      // Pending queue empty so freshBudget = TELEGRAM_MAX_MESSAGES_PER_RUN.
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_depeg = 1", rows: directDepegRows },
      { match: "WHERE global_alert_depeg = 1", rows: globalDepegRows },
      // Capacity-overflow enqueue (one batch INSERT per overflowed chunk).
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { depeg: number; depegTriggered: number };
      cappedAtLimit: boolean;
      pendingEnqueued: number;
      messagesSent: number;
      freshAttempted: number;
    };

    // All 120 depeg events were detected and routed as fresh triggers.
    expect(metadata.eventsDetected.depeg).toBe(120);
    expect(metadata.eventsDetected.depegTriggered).toBe(120);

    // sendBatch is invoked at least once; locate the call carrying mega-chat
    // messages and confirm the consolidated body was split into >1 chunks.
    expect(mockSendBatch).toHaveBeenCalled();
    const allSentMessages = mockSendBatch.mock.calls.flatMap(
      ([messages]) => messages as Array<{ chatId: string; html: string; chunkIndex?: number; canonicalHtml?: string }>,
    );
    const megaMessages = allSentMessages.filter((msg) => msg.chatId === megaChatId);
    expect(megaMessages.length).toBeGreaterThan(1); // split into multiple chunks
    // Each chunk respects the 4000-char cap.
    for (const msg of megaMessages) {
      expect(msg.html.length).toBeLessThanOrEqual(4000);
    }
    // The canonical pre-split body is shared across mega's chunks and is the
    // SAME body, so all chunks reference the same canonicalHtml.
    const canonicals = new Set(megaMessages.map((m) => m.canonicalHtml));
    expect(canonicals.size).toBe(1);
    // chunkIndex covers [0, megaMessages.length - 1] without gaps.
    const indices = megaMessages.map((m) => m.chunkIndex ?? 0).sort((a, b) => a - b);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(megaMessages.length - 1);

    // Cap and overflow: the queue is capped and excess subscribers are accounted
    // for without formatting the whole deferred tail in this invocation.
    expect(metadata.cappedAtLimit).toBe(true);
    // freshAttempted is bounded by the cap.
    expect(metadata.freshAttempted).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGES_PER_RUN);

    // The residual overflow was persisted as an unformatted plan for a later
    // bounded enqueue pass.
    const overflowBacklogWrite = mockSetCache.mock.calls.find((call) => call[1] === "telegram:dispatch-overflow-plan");
    expect(overflowBacklogWrite).toBeDefined();
    const overflowBacklog = JSON.parse(String(overflowBacklogWrite?.[2])) as {
      plans: unknown[];
    };
    expect(overflowBacklog.plans.length).toBeGreaterThan(0);

    // Mega chat is among the chats that got at least one fresh attempt — the
    // multi-chunk consumer did not prevent other chats from being processed.
    const sentChatIds = new Set(allSentMessages.map((m) => m.chatId));
    expect(sentChatIds.has(megaChatId)).toBe(true);
    expect(sentChatIds.size).toBeGreaterThan(1);
  });

  it("preserves the launch snapshot in the seed branch so the next healthy run still detects the transition (P1.7)", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Stand-in prior launch snapshot: pretend usdc-circle was pre-launch on the
    // last healthy run. usdc-circle is in ACTIVE_IDS but not in the live
    // PRE_LAUNCH_STABLECOINS, so it represents the kind of pre-launch -> active
    // transition this test exercises.
    const preservedLaunchIds = ["usdc-circle"];
    // First cycle: dews + depeg snapshots are missing -> seed branch fires.
    let snapshotsHealthy = false;
    let cachedLaunchSnapshot: string = JSON.stringify(preservedLaunchIds);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:launch-snapshot") {
        return { value: cachedLaunchSnapshot, updatedAt: now - 60 };
      }
      if (!snapshotsHealthy) {
        // Force seed branch by returning null for dews/depeg in cycle 1.
        return null;
      }
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:dews-alertable-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    // The seed branch writes via setCache; capture the launch-snapshot write
    // so we can prove it preserved the prior IDs instead of overwriting them
    // with the (empty-of-usdc-circle) current PRE_LAUNCH set.
    mockSetCache.mockImplementation(async (_db: unknown, key: string, value: string) => {
      if (key === "alert:launch-snapshot") {
        cachedLaunchSnapshot = value;
      }
      return undefined;
    });

    // Cycle 1: seed branch only needs the three source SELECTs.
    const dbCycle1 = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
    ]);
    const cycle1 = await dispatchTelegramAlerts(dbCycle1, "bot-token");
    const cycle1Meta = JSON.parse(cycle1.metadata) as { snapshotSeeded: boolean };
    expect(cycle1Meta.snapshotSeeded).toBe(true);

    // Bug regression guard: the seed branch must NOT have written the live
    // PRE_LAUNCH_STABLECOINS set; the prior `["usdc-circle"]` must survive.
    const parsedAfterSeed = JSON.parse(cachedLaunchSnapshot) as string[];
    expect(parsedAfterSeed).toContain("usdc-circle");

    // Cycle 2: snapshots are now healthy. The preserved prior launch snapshot
    // contains usdc-circle; the live PRE_LAUNCH_STABLECOINS does not (usdc-circle
    // is active), so the launch diff must surface a launch alert.
    snapshotsHealthy = true;
    const dbCycle2 = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_launch = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "555", last_active_at: now }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const cycle2 = await dispatchTelegramAlerts(dbCycle2, "bot-token");
    const cycle2Meta = JSON.parse(cycle2.metadata) as {
      eventsDetected: { launch: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(cycle2Meta.eventsDetected.launch).toBe(1);
    expect(cycle2Meta.subscribersNotified).toBe(1);
    expect(cycle2Meta.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat.mock.calls[0]?.[0]).toBe("555");
  });

  it("does not reset the reserve baseline when the producer snapshot is corrupt", async () => {
    const now = Math.floor(Date.now() / 1000);
    let producerReserveSnapshot = "{";
    let cachedReserveDispatched = JSON.stringify(["usdc-circle"]);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot" || key === "alert:dews-alertable-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({});
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({}, now - 60);
      }
      if (key === "alert:reserve-snapshot") {
        return { value: producerReserveSnapshot, updatedAt: now - 60 };
      }
      if (key === "alert:reserve-dispatched-snapshot") {
        return { value: cachedReserveDispatched, updatedAt: now - 60 };
      }
      return null;
    });

    mockSetCache.mockImplementation(async (_db: unknown, key: string, value: string) => {
      if (key === "alert:reserve-dispatched-snapshot") {
        cachedReserveDispatched = value;
      }
      return undefined;
    });

    const dbCycle1 = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
    ]);

    const cycle1 = await dispatchTelegramAlerts(dbCycle1, "bot-token");
    const cycle1Meta = JSON.parse(cycle1.metadata) as {
      eventlessFastPath?: boolean;
      reserveSourceUnavailable?: boolean;
      eventsDetected: { reserve: number };
    };

    expect(cycle1Meta.eventlessFastPath).toBe(true);
    expect(cycle1Meta.reserveSourceUnavailable).toBe(true);
    expect(cycle1Meta.eventsDetected.reserve).toBe(0);
    expect(JSON.parse(cachedReserveDispatched)).toEqual(["usdc-circle"]);

    producerReserveSnapshot = JSON.stringify({
      generation: ALERT_RESERVE_SOURCE_GENERATION,
      publishedAt: now,
      continuous: false,
      driftIds: ["usdc-circle"],
    });
    const dbCycle2 = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
    ]);

    const cycle2 = await dispatchTelegramAlerts(dbCycle2, "bot-token");
    const cycle2Meta = JSON.parse(cycle2.metadata) as {
      eventlessFastPath?: boolean;
      reserveSourceUnavailable?: boolean;
      reserveAlertSourceState?: string;
      eventsDetected: { reserve: number };
    };

    expect(cycle2Meta.eventlessFastPath).toBe(true);
    expect(cycle2Meta.reserveSourceUnavailable).toBe(true);
    expect(cycle2Meta.reserveAlertSourceState).toBe("recovering");
    expect(cycle2Meta.eventsDetected.reserve).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("persists alert job manifests for reserve fanout", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot" || key === "alert:dews-alertable-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({});
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({}, now - 60);
      }
      if (key === "alert:reserve-snapshot") {
        return {
          value: JSON.stringify({
            generation: ALERT_RESERVE_SOURCE_GENERATION,
            publishedAt: now - 60,
            continuous: true,
            driftIds: ["usdc-circle"],
          }),
          updatedAt: now - 60,
        };
      }
      if (key === "alert:reserve-dispatched-snapshot") {
        return { value: JSON.stringify([]), updatedAt: now - 60 };
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_reserve = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "555", last_active_at: now }],
      },
      { match: "WHERE global_alert_reserve = 1", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { reserve: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.reserve).toBe(1);
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(
      db
        .getHistory()
        .some((entry) => entry.sql.includes("INSERT INTO telegram_alert_jobs") && entry.binds[1] === "reserve"),
    ).toBe(true);
    expect(
      db
        .getHistory()
        .some((entry) => entry.sql.includes("INSERT INTO telegram_alert_job_targets") && entry.binds[4] === "reserve"),
    ).toBe(true);
  });

  it("emits only the new trigger when an active depeg closes and reopens within one window", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Prior depeg snapshot: event #1 active for usdc-circle (eventId carried).
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:dews-alertable-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return {
          value: JSON.stringify({
            "usdc-circle": {
              stablecoinId: "usdc-circle",
              symbol: "USDC",
              direction: "below",
              deviationBps: 120,
              price: 0.988,
              pegReference: 1,
              eventId: 1,
            },
          }),
          updatedAt: now - 60,
        };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    // Current state: event #1 ended 1 minute ago; event #2 is now active for the
    // same coin with a different event_id. The active SELECT returns event #2;
    // the resolved-lookup SELECT (MAX(ended_at)) returns event #1.
    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            event_id: 2,
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 90,
            start_price: 0.991,
            peg_reference: 1,
          },
        ],
      },
      {
        match: "FROM depeg_events event",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            peak_deviation_bps: 120,
            started_at: now - 1800,
            ended_at: now - 60,
            recovery_price: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_depeg = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: {
        depeg: number;
        depegTriggered: number;
        depegResolved: number;
        depegWorsening: number;
      };
    };

    // The new event #2 triggers, but the just-ended event #1 is represented as
    // recovery context rather than a contradictory resolved section.
    expect(metadata.eventsDetected.depegTriggered).toBe(1);
    expect(metadata.eventsDetected.depegResolved).toBe(0);
    // Worsening must NOT fire — event #1 != event #2; the new event is a
    // fresh trigger, not a worsening of the prior event.
    expect(metadata.eventsDetected.depegWorsening).toBe(0);
    const sentHtml = String(mockSendToChat.mock.calls[0]?.[1] ?? "");
    expect(sentHtml).toContain("Depeg Detected");
    expect(sentHtml).not.toContain("Depeg Resolved");
    expect(sentHtml).toContain("Re-depegged after 29m recovery");
  });
});
