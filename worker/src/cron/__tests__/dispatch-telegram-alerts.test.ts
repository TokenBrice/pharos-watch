import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const mockGetCache = vi.fn();
const mockSetCache = vi.fn();

vi.mock("../../lib/db-cache", () => ({
  getCache: mockGetCache,
  setCache: mockSetCache,
}));

const mockShouldAttemptFetch = vi.fn();
const mockRecordOutcome = vi.fn();

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: mockShouldAttemptFetch,
  recordOutcome: mockRecordOutcome,
}));

const mockSendToChat = vi.fn();
const mockSendBatch = vi.fn();

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return {
    ...actual,
    sendToChat: mockSendToChat,
    sendBatch: mockSendBatch,
  };
});

const { dispatchTelegramAlerts } = await import("../dispatch-telegram-alerts");

beforeEach(() => {
  mockGetCache.mockReset();
  mockSetCache.mockReset();
  mockShouldAttemptFetch.mockReset();
  mockRecordOutcome.mockReset();
  mockSendToChat.mockReset();
  mockSendBatch.mockReset();

  mockShouldAttemptFetch.mockResolvedValue(true);
  mockSetCache.mockResolvedValue(undefined);
  mockRecordOutcome.mockResolvedValue(undefined);
  mockSendToChat.mockResolvedValue({
    ok: true,
    blocked: false,
    retryable: false,
    permanentFailure: false,
    statusCode: 200,
    errorClass: null,
    delivery: "sent",
    retryAfterSec: null,
  });

  // Default sendBatch: delegate each message to mockSendToChat
  mockSendBatch.mockImplementation(
    async (messages: Array<{ chatId: string; html: string; disableNotification: boolean }>, _botToken: string) => {
      const results = [];
      for (const msg of messages) {
        const result = await mockSendToChat(msg.chatId, msg.html, _botToken, {});
        results.push({ chatId: msg.chatId, ...result });
      }
      return results;
    },
  );
});

describe("dispatchTelegramAlerts", () => {
  it("skips when circuit breaker is open", async () => {
    mockShouldAttemptFetch.mockResolvedValue(false);

    const db = mockD1([]);
    const result = await dispatchTelegramAlerts(db, "bot-token");

    expect(JSON.parse(result.metadata)).toHaveProperty("skipped", "circuit-open");
    expect(result.itemCount).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it("seeds snapshots on first run", async () => {
    mockGetCache.mockResolvedValue(null);

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      snapshotSeeded: boolean;
      subscribersNotified: number;
    };

    expect(result.itemCount).toBe(0);
    expect(metadata.snapshotSeeded).toBe(true);
    expect(metadata.subscribersNotified).toBe(0);
    expect(mockSetCache).toHaveBeenCalledTimes(5);
    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
  });

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
        return {
          value: JSON.stringify({
            "usdc-circle": { grade: "B", score: 78 },
          }),
          updatedAt: now - 60,
        };
      }
      return null;
    });

    const db = mockD1([
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
      { match: "SELECT id, chat_id, message_html", rows: [] },
      // Phase 3: batched subscriber lookups
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle"], rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }] },
      {
        match: "sub.alert_depeg = 1",
        matchBinds: ["usdc-circle"],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      {
        match: "sub.alert_safety = 1",
        matchBinds: ["usdc-circle"],
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

    const db = mockD1([
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
      { match: "SELECT id, chat_id, message_html", rows: [] },
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle"], rows: [] },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [{ chat_id: "777", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null }],
      },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
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

    const db = mockD1([
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
      { match: "SELECT id, chat_id, message_html", rows: [] },
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

    const db = mockD1([
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
      { match: "SELECT id, chat_id, message_html", rows: [] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle"],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "777", last_active_at: now, dews_min_band: "WARNING" }],
      },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [{ chat_id: "777", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null }],
      },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
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

  it("uses per-coin latest safety rows and prev_grade when repairing a partial legacy snapshot", async () => {
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
      return null;
    });

    const db = mockD1([
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
      { match: "SELECT id, chat_id, message_html", rows: [] },
      {
        match: "sub.alert_safety = 1",
        matchBinds: ["bold-liquity"],
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

    expect(metadata.eventsDetected.safety).toBe(1);
    expect(metadata.subscribersNotified).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat.mock.calls[0]?.[1]).toContain("A- → B+");
    expect(mockSendToChat.mock.calls[0]?.[1]).not.toContain("UNKNOWN");

    const safetySnapshotCall = mockSetCache.mock.calls.find((call) => call[1] === "alert:safety-snapshot");
    expect(safetySnapshotCall?.[2]).toContain("\"bold-liquity\"");
    expect(safetySnapshotCall?.[2]).toContain("\"usdc-circle\"");
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
      return null;
    });

    const db = mockD1([
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
      { match: "SELECT id, chat_id, message_html", rows: [] },
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

    const safetySnapshotCall = mockSetCache.mock.calls.find((call) => call[1] === "alert:safety-snapshot");
    expect(safetySnapshotCall?.[2]).toContain("\"bold-liquity\"");
    expect(safetySnapshotCall?.[2]).toContain("\"usdc-circle\"");
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

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 20, band: "WATCH", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      // Phase 1: pending queue drain (empty)
      { match: "SELECT id, chat_id, message_html", rows: [] },
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

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "uusd-youves", score: 39, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "SELECT id, chat_id, message_html", rows: [] },
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

    const dewsAlertableSnapshotCall = mockSetCache.mock.calls.find(
      (call) => call[1] === "alert:dews-alertable-snapshot",
    );
    expect(dewsAlertableSnapshotCall?.[2]).toContain("\"uusd-youves\":\"ALERT\"");
  });

  it("deactivates subscriber on blocked telegram response", async () => {
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

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      // Phase 1: pending queue drain (empty)
      { match: "SELECT id, chat_id, message_html", rows: [] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle"],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "99999", last_active_at: now }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      // Phase 6: cleanup expired pending
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { blockedUsersCleanedUp: number };

    expect(metadata.blockedUsersCleanedUp).toBe(1);
  });

  it("drains pending queue before processing fresh events", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Fresh snapshots — no diffs
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      // Pending queue has 2 messages
      {
        match: "SELECT id, chat_id, message_html",
        rows: [
          { id: 1, chat_id: "100", message_html: "<b>Old alert</b>", disable_notification: 0, created_at: now - 120, attempts: 0 },
          { id: 2, chat_id: "200", message_html: "<b>Old alert 2</b>", disable_notification: 1, created_at: now - 60, attempts: 0 },
        ],
      },
      // DELETE for delivered pending alerts
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
      // Cleanup expired
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { pendingDrained: number; messagesSent: number };

    expect(metadata.pendingDrained).toBe(2);
    // drainPendingQueue calls sendToChat directly (not sendBatch)
    expect(mockSendToChat).toHaveBeenCalledTimes(2);
  });

  it("enqueues overflow subscribers to pending queue", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    // Generate more subscribers than MAX_MESSAGES_PER_RUN
    const subscriberCount = 250;
    const subscribers = Array.from({ length: subscriberCount }, (_, i) => ({
      stablecoin_id: "usdc-circle",
      chat_id: `chat-${i}`,
      last_active_at: now - i,
    }));

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      // No pending queue items
      { match: "SELECT id, chat_id, message_html", rows: [] },
      // Batched subscriber lookup returns all 250
      { match: "sub.alert_dews = 1", rows: subscribers },
      // INSERT for overflow (db.batch call)
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      // Cleanup expired
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      subscribersNotified: number;
      cappedAtLimit: boolean;
      pendingEnqueued: number;
    };

    expect(metadata.cappedAtLimit).toBe(true);
    expect(metadata.pendingEnqueued).toBeGreaterThan(0);
    // freshBudget = 200 (no pending drained), so 200 sent + 50 enqueued
    expect(metadata.subscribersNotified).toBeLessThanOrEqual(200);
  });

  it("writes snapshots even when subscriber queue is capped", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const subscribers = Array.from({ length: 250 }, (_, i) => ({
      stablecoin_id: "usdc-circle",
      chat_id: `chat-${i}`,
      last_active_at: now - i,
    }));

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "SELECT id, chat_id, message_html", rows: [] },
      { match: "sub.alert_dews = 1", rows: subscribers },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    await dispatchTelegramAlerts(db, "bot-token");

    // Snapshots are written with the NEW state (WARNING), not held back
    const dewsSnapshotCall = mockSetCache.mock.calls.find(
      (call) => call[1] === "alert:dews-snapshot",
    );
    expect(dewsSnapshotCall).toBeDefined();
    expect(dewsSnapshotCall?.[2]).toContain("WARNING");
  });

  it("cleans up expired pending alerts", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "SELECT id, chat_id, message_html", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [], runMeta: { changes: 5 } },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { pendingExpired: number };

    expect(metadata.pendingExpired).toBe(5);
  });

  it("queues retryable fresh-send failures instead of dropping them", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 500,
      errorClass: "server_error",
      delivery: "retryable_failure",
      retryAfterSec: null,
    });

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "SELECT id, chat_id, message_html", rows: [] },
      { match: "sub.alert_dews = 1", rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }] },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      freshRetryQueued: number;
      pendingEnqueued: number;
      messagesSent: number;
    };

    expect(metadata.freshRetryQueued).toBe(1);
    expect(metadata.pendingEnqueued).toBe(1);
    expect(metadata.messagesSent).toBe(0);
  });

  it("emits worsening depeg alerts when the configured bps step is crossed", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
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
            },
          }),
          updatedAt: now - 60,
        };
      }
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [{ stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below", peak_deviation_bps: 260, start_price: 0.974, peg_reference: 1 }],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "SELECT id, chat_id, message_html", rows: [] },
      {
        match: "sub.alert_depeg = 1",
        rows: [{
          stablecoin_id: "usdc-circle",
          chat_id: "12345",
          last_active_at: now,
          depeg_worsening_bps_step: 100,
        }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { eventsDetected: { depegWorsening: number } };

    expect(metadata.eventsDetected.depegWorsening).toBe(1);
    expect(mockSendToChat.mock.calls[0]?.[1]).toContain("worsening");
  });

  it("suppresses safety alerts when only the methodology version changed", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") {
        return {
          value: JSON.stringify({
            "usdc-circle": { grade: "B", score: 78, methodologyVersion: "v1" },
          }),
          updatedAt: now - 60,
        };
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "FROM safety_grade_history",
        rows: [{
          stablecoin_id: "usdc-circle",
          grade: "C",
          score: 61,
          prev_grade: "B",
          prev_score: 78,
          recorded_at: now,
          methodology_version: "v2",
        }],
      },
      { match: "SELECT id, chat_id, message_html", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number; suppressedMethodologyChanges: number };
      messagesSent: number;
    };

    expect(metadata.eventsDetected.safety).toBe(0);
    expect(metadata.eventsDetected.suppressedMethodologyChanges).toBe(1);
    expect(metadata.messagesSent).toBe(0);
  });
});
