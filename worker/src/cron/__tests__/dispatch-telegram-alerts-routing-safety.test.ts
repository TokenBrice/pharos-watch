import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockGetCache,
  mockSendToChat,
  dispatchTelegramAlerts,
  makeSafetySourceCache,
  makeSafetySnapshotCache,
  resetDispatchTelegramAlertsTest,
  cleanupDispatchTelegramAlertsTest,
  fixtureMockD1,
} from "./dispatch-telegram-alerts.test-support";

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);
  it("detects DEWS/depeg/safety changes and fans out to subscribers", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({
          "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "C", score: 61, methodologyVersion: "7.09" },
          },
          now - 60,
        );
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
      {
        match: "FROM safety_grade_history",
        rows: [{ stablecoin_id: "usdc-circle", grade: "C", score: 61 }],
      },
      // Phase 1: pending queue drain (empty)
      { match: "FROM telegram_pending_alerts p", rows: [] },
      // Phase 3: batched subscriber lookups
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      {
        match: "sub.alert_depeg = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      {
        match: "sub.alert_safety = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      // Phase 6: cleanup expired pending
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { dews: number; depeg: number; safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected).toMatchObject({
      dews: 1,
      depeg: 1,
      depegTriggered: 1,
      depegResolved: 0,
      depegWorsening: 0,
      safety: 1,
      suppressedMethodologyChanges: 0,
    });
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
  });

  it("suppresses only safety alerts when the live safety source cache is from the wrong generation", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache(
          {
            "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.08" },
          },
          "legacy-generation",
        );
      }
      if (key === "alert:safety-source-cache") {
        return {
          value: JSON.stringify({
            generation: "legacy-generation",
            methodologyVersion: "7.09",
            publishedAt: now - 60,
            snapshot: {
              "usdc-circle": { grade: "C", score: 61, methodologyVersion: "7.09" },
            },
          }),
          updatedAt: now - 60,
        };
      }
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "FROM safety_grade_history",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            grade: "C",
            score: 61,
            prev_grade: "B",
            prev_score: 78,
            recorded_at: now,
            methodology_version: "7.09",
          },
        ],
      },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      {
        match: "sub.alert_safety = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { dews: number; safety: number };
      messagesSent: number;
      safetyAlertSourceState: string;
      safetyAlertsSuppressed: boolean;
    };

    expect(metadata.eventsDetected.dews).toBe(1);
    expect(metadata.eventsDetected.safety).toBe(0);
    expect(metadata.messagesSent).toBe(1);
    expect(metadata.safetyAlertSourceState).toBe("wrong-generation");
    expect(metadata.safetyAlertsSuppressed).toBe(true);
  });

  it("fans out global all-stablecoin alert subscriptions without per-coin rows", async () => {
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
            chat_id: "777",
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
      eventsDetected: { dews: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.dews).toBe(1);
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat.mock.calls[0]?.[0]).toBe("777");
  });

  it("sends global safety alerts only for material downgrades", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({
          "usdc-circle": { grade: "B", score: 70, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "C+", score: 66, methodologyVersion: "7.09" },
          },
          now - 60,
        );
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_safety = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_safety = 1",
        rows: [
          {
            chat_id: "777",
            last_active_at: now,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.safety).toBe(1);
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat.mock.calls[0]?.[0]).toBe("777");
  });

  it("sends global safety alerts for scoreless downgrades", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({
          "usdc-circle": { grade: "B", score: null, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "C+", score: null, methodologyVersion: "7.09" },
          },
          now - 60,
        );
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_safety = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_safety = 1",
        rows: [
          {
            chat_id: "777",
            last_active_at: now,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.safety).toBe(1);
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat.mock.calls[0]?.[0]).toBe("777");
  });

  it("suppresses minor global safety downgrades", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({
          "usdc-circle": { grade: "B-", score: 65, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "C+", score: 64, methodologyVersion: "7.09" },
          },
          now - 60,
        );
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_safety = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_safety = 1",
        rows: [
          {
            chat_id: "777",
            last_active_at: now,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.safety).toBe(1);
    expect(metadata.subscribersNotified).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("batches resolved depeg lookups into one query", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return {
          value: JSON.stringify({
            "usdc-circle": {
              symbol: "USDC",
              direction: "below",
              deviationBps: 125,
              price: 0.9875,
              pegReference: 1,
            },
            "usdt-tether": {
              symbol: "USDT",
              direction: "below",
              deviationBps: 110,
              price: 0.989,
              pegReference: 1,
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

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "FROM depeg_events event",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            peak_deviation_bps: 125,
            started_at: now - 3600,
            ended_at: now - 300,
            recovery_price: 1,
          },
          {
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peak_deviation_bps: 110,
            started_at: now - 1800,
            ended_at: now - 240,
            recovery_price: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { depegResolved: number; depeg: number };
    };

    expect(metadata.eventsDetected.depegResolved).toBe(2);
    expect(metadata.eventsDetected.depeg).toBe(2);

    const resolvedLookupQueries = db.getHistory().filter((entry) => entry.sql.includes("FROM depeg_events event"));
    expect(resolvedLookupQueries).toHaveLength(1);
    expect(resolvedLookupQueries[0]?.binds).toHaveLength(2);
  });

  it("chunks resolved depeg and fan-out IN queries above 100 changed coins", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 101 }, (_, index) => `synthetic-${index}`);
    const previousDepegSnapshot = Object.fromEntries(
      ids.map((stablecoinId, index) => [
        stablecoinId,
        {
          symbol: `S${index}`,
          direction: "below",
          deviationBps: 125,
          price: 0.9875,
          pegReference: 1,
        },
      ]),
    );

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify(previousDepegSnapshot), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      return null;
    });

    const resolvedRows = ids.map((stablecoinId, index) => ({
      stablecoin_id: stablecoinId,
      symbol: `S${index}`,
      peak_deviation_bps: 125,
      started_at: now - 3_600,
      ended_at: now - 300,
      recovery_price: 1,
    }));
    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM depeg_events event", rows: resolvedRows },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "FROM telegram_subscriptions\n          WHERE stablecoin_id IN", rows: [] },
      { match: "SELECT id, chat_id, message_html", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { eventsDetected: { depegResolved: number } };

    expect(metadata.eventsDetected.depegResolved).toBe(101);
    const inQueries = db
      .getHistory()
      .filter(
        (entry) =>
          entry.sql.includes("FROM depeg_events event") ||
          entry.sql.includes("sub.alert_depeg = 1") ||
          entry.sql.includes("FROM telegram_subscriptions\n          WHERE stablecoin_id IN"),
      );
    expect(inQueries.length).toBeGreaterThanOrEqual(6);
    expect(inQueries.every((entry) => entry.binds.length <= 100)).toBe(true);
    const resolvedLookupQueries = inQueries.filter((entry) => entry.sql.includes("FROM depeg_events event"));
    expect(resolvedLookupQueries.map((entry) => entry.binds.length)).toEqual([90, 11]);
  });

  it("lets a per-coin DEWS threshold override a global all-stablecoin follow", async () => {
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
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "777", last_active_at: now, dews_min_band: "WARNING" }],
      },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [
          {
            chat_id: "777",
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
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.subscribersNotified).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("lets a per-coin safety follow override the global material-only safety tier", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({
          "usdc-circle": { grade: "B-", score: 65, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "C+", score: 64, methodologyVersion: "7.09" },
          },
          now - 60,
        );
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_safety = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [
          {
            stablecoin_id: "usdc-circle",
            chat_id: "777",
            last_active_at: now,
            safety_mode: null,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      {
        match: "WHERE global_alert_safety = 1",
        rows: [
          {
            chat_id: "777",
            last_active_at: now,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
  });

  it("lets a restrictive per-coin safety mode suppress the global safety tier", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({
          "usdc-circle": { grade: "B", score: 70, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "C+", score: 66, methodologyVersion: "7.09" },
          },
          now - 60,
        );
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_safety = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [
          {
            stablecoin_id: "usdc-circle",
            chat_id: "777",
            last_active_at: now,
            safety_mode: "upgrade-only",
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      {
        match: "WHERE global_alert_safety = 1",
        rows: [
          {
            chat_id: "777",
            last_active_at: now,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.subscribersNotified).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("treats first-seen ids in a partial legacy safety snapshot as seed-only without alerting", async () => {
    const now = 1_778_150_000;
    const snapshotUpdatedAt = now - 3600;

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: snapshotUpdatedAt };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: snapshotUpdatedAt };
      }
      if (key === "alert:safety-snapshot") {
        return {
          value: JSON.stringify({
            "usdc-circle": { grade: "A", score: 84 },
          }),
          updatedAt: snapshotUpdatedAt,
        };
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "A", score: 84, methodologyVersion: "7.09" },
            "bold-liquity": { grade: "B+", score: 79, methodologyVersion: "7.09" },
          },
          snapshotUpdatedAt,
        );
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "GROUP BY stablecoin_id",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            grade: "A",
            score: 84,
            prev_grade: null,
            prev_score: null,
            recorded_at: snapshotUpdatedAt - 86_400,
          },
          {
            stablecoin_id: "bold-liquity",
            grade: "B+",
            score: 79,
            prev_grade: "A-",
            prev_score: 80,
            recorded_at: snapshotUpdatedAt + 60,
          },
        ],
      },
      // Phase 1: pending queue drain (empty)
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        // Timestamp bind is dynamic (Date.now() inside dispatcher) so matchBinds
        // here is loose — SQL substring alone distinguishes the safety lookup.
        match: "sub.alert_safety = 1",
        rows: [{ stablecoin_id: "bold-liquity", chat_id: "12345", last_active_at: now }],
      },
      // Phase 6: cleanup expired pending
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      subscribersNotified: number;
    };

    expect(metadata.eventsDetected.safety).toBe(0);
    expect(metadata.subscribersNotified).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();

    const safetySnapshotCall = db.getHistory().find(
      (entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "alert:safety-snapshot",
    );
    expect(String(safetySnapshotCall?.binds[1])).toContain('"bold-liquity"');
    expect(String(safetySnapshotCall?.binds[1])).toContain('"usdc-circle"');
  });

  it("does not alert on historical rows missing from a partial legacy safety snapshot", async () => {
    const now = 1_778_150_000;
    const snapshotUpdatedAt = now - 3600;

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: snapshotUpdatedAt };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: snapshotUpdatedAt };
      }
      if (key === "alert:safety-snapshot") {
        return {
          value: JSON.stringify({
            "usdc-circle": { grade: "A", score: 84 },
          }),
          updatedAt: snapshotUpdatedAt,
        };
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "A", score: 84, methodologyVersion: "7.09" },
            "bold-liquity": { grade: "A-", score: 80, methodologyVersion: "7.09" },
          },
          snapshotUpdatedAt,
        );
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "GROUP BY stablecoin_id",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            grade: "A",
            score: 84,
            prev_grade: null,
            prev_score: null,
            recorded_at: snapshotUpdatedAt - 86_400,
          },
          {
            stablecoin_id: "bold-liquity",
            grade: "A-",
            score: 80,
            prev_grade: "B+",
            prev_score: 79,
            recorded_at: snapshotUpdatedAt - 86_400,
          },
        ],
      },
      // Phase 1: pending queue drain (empty)
      { match: "FROM telegram_pending_alerts p", rows: [] },
      // Phase 6: cleanup expired pending
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.safety).toBe(0);
    expect(metadata.subscribersNotified).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();

    const safetySnapshotCall = db.getHistory().find(
      (entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "alert:safety-snapshot",
    );
    expect(String(safetySnapshotCall?.binds[1])).toContain('"bold-liquity"');
    expect(String(safetySnapshotCall?.binds[1])).toContain('"usdc-circle"');
  });

  it("ignores DEWS transitions to CALM/WATCH", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "ALERT" }), updatedAt: now - 60 };
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
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 20, band: "WATCH", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      // Phase 1: pending queue drain (empty)
      { match: "FROM telegram_pending_alerts p", rows: [] },
      // Phase 6: cleanup expired pending
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { eventsDetected: { dews: number } };

    expect(metadata.eventsDetected.dews).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("does not resend the same DEWS alert band after a silent WATCH/CALM dip", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "uusd-youves": "WATCH" }), updatedAt: now - 60 };
      }
      if (key === "alert:dews-alertable-snapshot") {
        return { value: JSON.stringify({ "uusd-youves": "ALERT" }), updatedAt: now - 60 };
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
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "uusd-youves", score: 39, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { dews: number };
      messagesSent: number;
    };

    expect(metadata.eventsDetected.dews).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();

    const dewsAlertableSnapshotCall = db.getHistory().find(
      (entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "alert:dews-alertable-snapshot",
    );
    expect(String(dewsAlertableSnapshotCall?.binds[1])).toContain('"uusd-youves":"ALERT"');
  });
});
