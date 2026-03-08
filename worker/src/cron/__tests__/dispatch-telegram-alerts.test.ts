import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const mockGetCache = vi.fn();
const mockSetCache = vi.fn();

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getCache: mockGetCache,
    setCache: mockSetCache,
  };
});

const mockShouldAttemptFetch = vi.fn();
const mockRecordOutcome = vi.fn();

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: mockShouldAttemptFetch,
  recordOutcome: mockRecordOutcome,
}));

const mockSendToChat = vi.fn();

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return {
    ...actual,
    sendToChat: mockSendToChat,
  };
});

const { dispatchTelegramAlerts } = await import("../dispatch-telegram-alerts");

beforeEach(() => {
  mockGetCache.mockReset();
  mockSetCache.mockReset();
  mockShouldAttemptFetch.mockReset();
  mockRecordOutcome.mockReset();
  mockSendToChat.mockReset();

  mockShouldAttemptFetch.mockResolvedValue(true);
  mockSetCache.mockResolvedValue(undefined);
  mockRecordOutcome.mockResolvedValue(undefined);
  mockSendToChat.mockResolvedValue({ ok: true, blocked: false });
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
    expect(mockSetCache).toHaveBeenCalledTimes(3);
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
      { match: "u.alert_dews = 1", matchBinds: ["usdc-circle"], rows: [{ chat_id: "12345", last_active_at: now }] },
      {
        match: "u.alert_depeg = 1",
        matchBinds: ["usdc-circle"],
        rows: [{ chat_id: "12345", last_active_at: now }],
      },
      {
        match: "u.alert_safety = 1",
        matchBinds: ["usdc-circle"],
        rows: [{ chat_id: "12345", last_active_at: now }],
      },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { dews: number; depeg: number; safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected).toEqual({ dews: 1, depeg: 1, safety: 1 });
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
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
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { eventsDetected: { dews: number } };

    expect(metadata.eventsDetected.dews).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("deactivates subscriber on blocked telegram response", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockSendToChat.mockResolvedValue({ ok: false, blocked: true });
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
      {
        match: "u.alert_dews = 1",
        matchBinds: ["usdc-circle"],
        rows: [{ chat_id: "99999", last_active_at: now }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { blockedUsersCleanedUp: number };

    expect(metadata.blockedUsersCleanedUp).toBe(1);
  });
});
