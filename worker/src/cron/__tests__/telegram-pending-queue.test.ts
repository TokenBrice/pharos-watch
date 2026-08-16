import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mockD1 as createMockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import {
  serializePendingAlertScope,
  serializePendingMarkupPolicy,
} from "../../lib/telegram-pending-provenance";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

const DEFAULT_TELEGRAM_PENDING_D1_TABLES: MockTableConfig[] = [
  { match: "WHERE delivery_state = 'sending'", rows: [] },
  { match: "delivery_state = 'sent'", rows: [] },
  { match: "processing_owner = ?", rows: [] },
  { match: "SET attempts = attempts + 1", rows: [] },
  { match: "AND delivery_state = 'sending'", rows: [] },
  { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
  { match: "WHERE chat_id = ?", rows: [] },
  { match: "UPDATE telegram_recap_preferences", rows: [] },
  { match: "UPDATE telegram_recap_targets", rows: [] },
];

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_TELEGRAM_PENDING_D1_TABLES]);
}

const mockSendToChat = vi.fn();
const mockMigrateTelegramChatId = vi.fn();
const transportMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  readPause: vi.fn(),
  record: vi.fn(),
}));

function parseLogRecords(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function setupTelegramPendingSqlite(): { sqlite: DatabaseSync; db: D1Database } {
  return createLatestSchemaSqlite();
}

/**
 * Seeds the source event a `telegram_alert_job_targets` row with a
 * `plan_generation` needs to satisfy `trg_tajt_source_generation_guard`.
 */
function insertSourceEventSqlite(
  sqlite: DatabaseSync,
  row: { sourceEventId: string; planGeneration: number; detectedAt: number; expiresAt: number },
): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_events (
         source_event_id, status, detected_at, expires_at, event_payload, baseline_payload,
         target_plan_state, target_plan_generation
       ) VALUES (?, 'planned', ?, ?, '{}', '{}', 'materializing', ?)`,
    )
    .run(row.sourceEventId, row.detectedAt, row.expiresAt, row.planGeneration);
}

/** Seeds a subscriber row satisfying the production NOT NULL columns. */
function insertSubscriberSqlite(
  sqlite: DatabaseSync,
  row: {
    chatId: string;
    createdAt?: number;
    lastActiveAt?: number;
    preferenceGeneration?: number;
    alertSnoozeUntilTs?: number | null;
    quietHoursEnabled?: number;
    quietHoursStartUtc?: number | null;
    quietHoursEndUtc?: number | null;
    timezone?: string | null;
    globalAlertDews?: number;
    globalAlertDepeg?: number;
    globalAlertSafety?: number;
    globalAlertLaunch?: number;
    globalAlertReserve?: number;
    globalAlertFreeze?: number;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_subscribers (
         chat_id, created_at, last_active_at, preference_generation, alert_snooze_until_ts,
         quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc, timezone,
         global_alert_dews, global_alert_depeg, global_alert_safety,
         global_alert_launch, global_alert_reserve, global_alert_freeze
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.chatId,
      row.createdAt ?? 0,
      row.lastActiveAt ?? 0,
      row.preferenceGeneration ?? 0,
      row.alertSnoozeUntilTs ?? null,
      row.quietHoursEnabled ?? 0,
      row.quietHoursStartUtc ?? null,
      row.quietHoursEndUtc ?? null,
      row.timezone ?? null,
      row.globalAlertDews ?? 0,
      row.globalAlertDepeg ?? 0,
      row.globalAlertSafety ?? 0,
      row.globalAlertLaunch ?? 0,
      row.globalAlertReserve ?? 0,
      row.globalAlertFreeze ?? 0,
    );
}

function insertPendingSqlite(
  sqlite: DatabaseSync,
  row: {
    id: number;
    chatId: string;
    html: string;
    createdAt: number;
    disableNotification?: number;
    attempts?: number;
    notBeforeAt?: number | null;
    dedupeKey?: string | null;
    chunkIndex?: number | null;
    priority?: number | null;
    sourceType?: string | null;
    alertType?: string | null;
    expiresAt?: number | null;
    sourceEventId?: string | null;
    alertScopeJson?: string | null;
    preferenceGeneration?: number | null;
    markupPolicyJson?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_pending_alerts (
         id, chat_id, message_html, disable_notification, created_at, attempts,
         not_before_at, dedupe_key, chunk_index, priority, source_type, alert_type, expires_at,
         source_event_id, alert_scope_json, preference_generation, markup_policy_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.chatId,
      row.html,
      row.disableNotification ?? 0,
      row.createdAt,
      row.attempts ?? 0,
      row.notBeforeAt ?? null,
      row.dedupeKey ?? null,
      row.chunkIndex ?? 0,
      row.priority ?? TELEGRAM_PENDING_PRIORITY.legacy,
      row.sourceType ?? "legacy",
      row.alertType ?? null,
      row.expiresAt ?? null,
      row.sourceEventId ?? null,
      row.alertScopeJson ?? null,
      row.preferenceGeneration ?? null,
      row.markupPolicyJson ?? null,
    );
}

/**
 * Thin race harness over the real schema: the only fenced statement is the
 * claim-candidate SELECT, held until both drains have read it. Every other
 * statement — including the optimistic claim UPDATE that decides the winner —
 * runs against real SQLite.
 */
function createClaimContentionD1(sqlite: DatabaseSync): D1Database & {
  getHistory(): Array<{ sql: string; binds: unknown[] }>;
  getOwner(): string | null;
} {
  const inner = createSqliteD1(sqlite);
  const history: Array<{ sql: string; binds: unknown[] }> = [];
  let winningOwner: string | null = null;
  let candidateReads = 0;
  let releaseCandidateReads: (() => void) | null = null;
  const bothOwnersReadCandidate = new Promise<void>((resolve) => {
    releaseCandidateReads = resolve;
  });

  function makeStatement(sql: string, values: unknown[] = []): D1PreparedStatement {
    const bound = values.length > 0 ? inner.prepare(sql).bind(...values) : inner.prepare(sql);
    return {
      bind: (...nextValues: unknown[]) => makeStatement(sql, nextValues),
      first: async <T>() => {
        history.push({ sql, binds: [...values] });
        return bound.first<T>();
      },
      all: async <T>() => {
        history.push({ sql, binds: [...values] });
        const result = await bound.all<T>();
        if (sql.includes("SELECT p.id") && sql.includes("processing_owner IS NULL")) {
          candidateReads += 1;
          if (candidateReads === 2) releaseCandidateReads?.();
          await bothOwnersReadCandidate;
        }
        return result;
      },
      run: async () => {
        history.push({ sql, binds: [...values] });
        const result = await bound.run();
        if (
          sql.includes("UPDATE telegram_pending_alerts") &&
          sql.includes("SET processing_owner = ?") &&
          Number(result.meta?.changes ?? 0) > 0
        ) {
          winningOwner = String(values[0]);
        }
        return result;
      },
    } as unknown as D1PreparedStatement;
  }

  return {
    prepare: (sql: string) => makeStatement(sql),
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    getHistory: () => history.map((entry) => ({ sql: entry.sql, binds: [...entry.binds] })),
    getOwner: () => winningOwner,
  } as unknown as D1Database & {
    getHistory(): Array<{ sql: string; binds: unknown[] }>;
    getOwner(): string | null;
  };
}

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return { ...actual, sendToChat: mockSendToChat };
});
vi.mock("../../lib/telegram-transport-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram-transport-control")>();
  return {
    ...actual,
    claimTelegramTransportPermit: transportMocks.claim,
    readTelegramDeliveryPause: transportMocks.readPause,
    recordTelegramTransportOutcomes: transportMocks.record,
  };
});
vi.mock("../../lib/telegram-subscriber-lifecycle", () => ({
  migrateTelegramChatId: mockMigrateTelegramChatId,
}));

const {
  disableBlockedSubscriber,
  drainPendingQueue,
  enqueuePendingAlerts,
  cleanupExpiredPendingAlerts,
  archiveAgedExecutionUnknownPendingAlerts,
  countPendingAlertsForAdmin,
  clearPendingAlertsForAdmin,
  loadChatsInBackoff,
  readPendingCapacitySnapshot,
  estimateTelegramDrainTimeSec,
  registerSubscriberBlockAndShouldDisable,
  resetSubscriberBlockCount,
  pendingBackoffSec,
  PENDING_TTL_SEC,
  PENDING_MAX_ATTEMPTS,
  PENDING_BACKOFF_SCHEDULE_SEC,
  BLOCK_STRIKE_WINDOW_SEC,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_PENDING_PRIORITY,
  TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY,
  SEND_BATCH_SIZE,
  buildDedupeKey,
  EXPIRED_PENDING_CLEANUP_BATCH_LIMIT,
  PENDING_CLAIM_TTL_SEC,
  reconcileStalePendingSending,
} = await import("../telegram-pending");
const { TELEGRAM_SPLIT_VERSION } = await import("../../lib/telegram-alerts");

beforeEach(() => {
  mockSendToChat.mockReset();
  mockMigrateTelegramChatId.mockReset().mockResolvedValue(undefined);
  transportMocks.claim.mockReset().mockResolvedValue({
    allowed: true,
    mode: "pending",
    maxDistinctChats: SEND_BATCH_SIZE,
    reason: "closed",
    circuitGeneration: 0,
    probeOwner: null,
    probeGeneration: null,
    pauseGeneration: null,
    deferUntil: null,
  });
  transportMocks.readPause.mockReset().mockResolvedValue(null);
  transportMocks.record.mockReset().mockResolvedValue({ state: "closed", generation: 0 });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("disableBlockedSubscriber", () => {
  it("resets all alert flags including launch, reserve, and freeze for subscribers and subscriptions", async () => {
    const db = mockD1([
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
    ]);

    const result = await disableBlockedSubscriber(db, "blocked-chat");
    expect(result).toBe(true);

    const history = db.getHistory();
    const subscriberUpdate = history.find((e) => e.sql.includes("UPDATE telegram_subscribers"));
    expect(subscriberUpdate).toBeDefined();
    expect(subscriberUpdate!.sql).toContain("alert_launch=0");
    expect(subscriberUpdate!.sql).toContain("alert_reserve=0");
    expect(subscriberUpdate!.sql).toContain("alert_freeze=0");
    expect(subscriberUpdate!.sql).toContain("global_alert_launch=0");
    expect(subscriberUpdate!.sql).toContain("global_alert_reserve=0");
    expect(subscriberUpdate!.sql).toContain("global_alert_freeze=0");

    const subscriptionUpdate = history.find((e) => e.sql.includes("UPDATE telegram_subscriptions"));
    expect(subscriptionUpdate).toBeDefined();
    expect(subscriptionUpdate!.sql).toContain("alert_launch=0");
    expect(subscriptionUpdate!.sql).toContain("alert_reserve=0");
    expect(subscriptionUpdate!.sql).toContain("alert_freeze=0");

    const presetDelete = history.find((e) => e.sql.includes("DELETE FROM telegram_preset_subscriptions"));
    expect(presetDelete).toBeDefined();
    expect(presetDelete!.binds).toEqual(["blocked-chat"]);

    const recapPreferenceUpdate = history.find((e) => e.sql.includes("UPDATE telegram_recap_preferences"));
    expect(recapPreferenceUpdate).toBeDefined();
    expect(recapPreferenceUpdate!.sql).toContain("enabled = 0");
    expect(recapPreferenceUpdate!.sql).toContain("next_due_at = NULL");
    const recapTargetUpdate = history.find((e) => e.sql.includes("UPDATE telegram_recap_targets"));
    expect(recapTargetUpdate).toBeDefined();
    expect(recapTargetUpdate!.sql).toContain("status = 'cancelled'");
    expect(recapTargetUpdate!.sql).toContain("blocked_disabled");
  });

  it("returns false and logs on D1 error", async () => {
    const db = mockD1([
      { match: "UPDATE telegram_subscribers", rows: [], throwError: new Error("D1 overload") },
    ]);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await disableBlockedSubscriber(db, "bad-chat");
    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("registerSubscriberBlockAndShouldDisable", () => {
  it("returns false on the first strike and stamps the window", async () => {
    const now = 1_700_000_000;
    const db = mockD1([
      { match: "SELECT consecutive_block_count", rows: [] },
      { match: "UPDATE telegram_subscribers", rows: [] },
    ]);
    const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, "chat-1", now);
    expect(shouldDisable).toBe(false);
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE telegram_subscribers"));
    expect(updateCall!.binds).toEqual([1, now, "chat-1"]);
  });

  it("returns true on the second strike within the window", async () => {
    const now = 1_700_000_000;
    const db = mockD1([
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 60 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
    ]);
    const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, "chat-2", now);
    expect(shouldDisable).toBe(true);
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE telegram_subscribers"));
    // Count increments to 2 and first_at is preserved.
    expect(updateCall!.binds).toEqual([2, now - 60, "chat-2"]);
  });

  it("returns false when the prior strike falls outside the 24h window", async () => {
    const now = 1_700_000_000;
    const db = mockD1([
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - (BLOCK_STRIKE_WINDOW_SEC + 1) }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
    ]);
    const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, "chat-3", now);
    expect(shouldDisable).toBe(false);
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE telegram_subscribers"));
    expect(updateCall!.binds).toEqual([1, now, "chat-3"]);
  });

  it("returns false and logs on D1 SELECT error to avoid disabling on stale state", async () => {
    const db = mockD1([
      { match: "SELECT consecutive_block_count", rows: [], throwError: new Error("D1 overload") },
    ]);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, "chat-4", 1_700_000_000);
    expect(shouldDisable).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("resetSubscriberBlockCount", () => {
  it("issues an UPDATE clearing both counters", async () => {
    const db = mockD1([
      { match: "UPDATE telegram_subscribers", rows: [] },
    ]);
    await resetSubscriberBlockCount(db, "chat-reset");
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE telegram_subscribers"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toContain("consecutive_block_count = 0");
    expect(updateCall!.sql).toContain("consecutive_block_first_at = NULL");
    expect(updateCall!.binds).toEqual(["chat-reset"]);
  });
});


describe("enqueuePendingAlerts", () => {
  it("uses the shared recap priority, six-hour TTL, and immutable markup provenance", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const markup = { inline_keyboard: [[{ text: "View watchlist", web_app: { url: "https://pharos.watch/pharoswatchbot" } }]] };
    await enqueuePendingAlerts(db, [{
      chatId: "recap-enqueue",
      html: "<b>Watchbot recap</b>",
      disableNotification: false,
      sourceEventId: "recap:recap-enqueue:2026-07-11:v1",
      preferenceGeneration: 3,
      replyMarkup: markup,
    }], 10_000, { sourceType: "personalized_recap" });

    expect(sqlite.prepare(
      `SELECT source_type, priority, expires_at, source_event_id, alert_scope_json,
              preference_generation, markup_policy_json
         FROM telegram_pending_alerts`,
    ).get()).toEqual({
      source_type: "personalized_recap",
      priority: 100,
      expires_at: 10_000 + 6 * 60 * 60,
      source_event_id: "recap:recap-enqueue:2026-07-11:v1",
      alert_scope_json: null,
      preference_generation: 3,
      markup_policy_json: serializePendingMarkupPolicy({ replyMarkup: markup }),
    });
    sqlite.close();
  });

  it("rejects a recap that lacks immutable delivery provenance", async () => {
    const db = mockD1([]);

    await expect(enqueuePendingAlerts(db, [{
      chatId: "invalid-recap",
      html: "<b>Watchbot recap</b>",
      disableNotification: false,
      sourceEventId: "recap:invalid-recap:2026-07-11:v1",
    }], 10_000, { sourceType: "personalized_recap" })).rejects.toThrow("incomplete provenance");
    expect(db.getHistory()).toHaveLength(0);
  });

  it("persists replay markup while using the admin delivery policy by default", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const markup = { inline_keyboard: [[{ text: "Open", callback_data: "admin:open" }]] };

    await enqueuePendingAlerts(db, [{
      chatId: "admin-replay",
      html: "<b>Replay</b>",
      disableNotification: false,
      replyMarkup: markup,
    }], 10_000, { sourceType: "admin_replay" });

    expect(sqlite.prepare(
      `SELECT source_type, priority, expires_at, source_event_id, alert_scope_json,
              preference_generation, markup_policy_json
         FROM telegram_pending_alerts`,
    ).get()).toEqual({
      source_type: "admin_replay",
      priority: TELEGRAM_PENDING_PRIORITY.adminBroadcast,
      expires_at: 10_000 + 45 * 60,
      source_event_id: null,
      alert_scope_json: null,
      preference_generation: null,
      markup_policy_json: serializePendingMarkupPolicy({ replyMarkup: markup }),
    });
    sqlite.close();
  });

  it("inserts messages into the pending table", async () => {
    const db = mockD1([
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
    ]);

    await enqueuePendingAlerts(
      db,
      [
        { chatId: "100", html: "<b>Alert 1</b>", disableNotification: false },
        { chatId: "200", html: "<b>Alert 2</b>", disableNotification: true },
      ],
      1000,
    );

    const history = db.getHistory();
    const inserts = history.filter((e) => e.sql.includes("INSERT INTO telegram_pending_alerts"));
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts[0]?.sql).toContain("dedupe_key");
    expect(inserts[0]?.sql).toContain("priority");
    expect(inserts[0]?.sql).toContain("source_type");
    expect(inserts[0]?.sql).toContain("expires_at");
    expect(inserts[0]?.sql).toContain("ON CONFLICT(dedupe_key) DO UPDATE");
  });

  it("updates one existing row on a dedupe-key collision instead of adding another row", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    try {
      const first = {
        chatId: "dedupe-chat",
        html: "<b>First chunk</b>",
        canonicalHtml: "<b>Canonical alert body</b>",
        disableNotification: false,
        chunkIndex: 0,
      };
      const second = {
        ...first,
        html: "<b>Updated chunk</b>",
        disableNotification: true,
      };
      const dedupeKey = buildDedupeKey(first);
      expect(buildDedupeKey(second)).toBe(dedupeKey);

      await enqueuePendingAlerts(db, [first], 1_000);
      await enqueuePendingAlerts(db, [second], 1_060, {
        notBeforeAt: 1_120,
        lastErrorClass: "rate_limit",
        retryAfterSec: 120,
      });

      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS row_count, COUNT(DISTINCT dedupe_key) AS dedupe_count FROM telegram_pending_alerts")
          .get(),
      ).toEqual({ row_count: 1, dedupe_count: 1 });
      expect(
        sqlite
          .prepare(
            `SELECT id, chat_id, message_html, disable_notification, created_at, updated_at,
                    attempts, not_before_at, last_error_class, retry_after_sec, dedupe_key
               FROM telegram_pending_alerts`,
          )
          .get(),
      ).toEqual({
        id: 1,
        chat_id: "dedupe-chat",
        message_html: "<b>Updated chunk</b>",
        disable_notification: 1,
        created_at: 1_000,
        updated_at: 1_060,
        attempts: 0,
        not_before_at: 1_120,
        last_error_class: "rate_limit",
        retry_after_sec: 120,
        dedupe_key: dedupeKey,
      });
    } finally {
      sqlite.close();
    }
  });

  it("preserves enqueue-generation provenance on a live dedupe collision", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    try {
      const first = {
        chatId: "provenance-chat",
        html: "<b>Alert</b>",
        canonicalHtml: "<b>Canonical alert</b>",
        disableNotification: false,
        chunkIndex: 0,
        alertType: "dews" as const,
        sourceEventId: "source-provenance",
        preferenceGeneration: 1,
        alertScope: [{ stablecoinId: "usdc-circle", family: "dews" as const }],
      };
      const laterGeneration = {
        ...first,
        preferenceGeneration: 9,
        replyMarkup: {
          inline_keyboard: [[{ text: "Snooze 1h", callback_data: "snooze:1h" }]],
        },
      };

      await enqueuePendingAlerts(db, [first], 1_000);
      await enqueuePendingAlerts(db, [laterGeneration], 1_060);

      const live = sqlite.prepare(
        `SELECT source_event_id, alert_scope_json, preference_generation, markup_policy_json
           FROM telegram_pending_alerts`,
      ).get() as Record<string, unknown>;
      expect(live.source_event_id).toBe("source-provenance");
      expect(live.preference_generation).toBe(1);
      expect(JSON.parse(String(live.alert_scope_json))).toEqual(first.alertScope);
      expect(JSON.parse(String(live.markup_policy_json))).toMatchObject({ replyMarkup: null });

      await enqueuePendingAlerts(db, [laterGeneration], 9_000);
      const refreshed = sqlite.prepare(
        `SELECT preference_generation, markup_policy_json FROM telegram_pending_alerts`,
      ).get() as Record<string, unknown>;
      expect(refreshed.preference_generation).toBe(9);
      expect(JSON.parse(String(refreshed.markup_policy_json))).toMatchObject({
        replyMarkup: laterGeneration.replyMarkup,
      });
    } finally {
      sqlite.close();
    }
  });

  it("rejects partially populated new-format risk provenance", async () => {
    const db = mockD1([{ match: "INSERT INTO telegram_pending_alerts", rows: [] }]);
    await expect(enqueuePendingAlerts(db, [{
      chatId: "partial-provenance",
      html: "<b>Alert</b>",
      disableNotification: false,
      sourceEventId: "source-partial",
    }], 1_000)).rejects.toThrow("incomplete provenance");
    expect(db.getHistory()).toHaveLength(0);
  });

  it("marks admin broadcasts as low-priority pending rows", async () => {
    const db = mockD1([
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
    ]);

    await enqueuePendingAlerts(
      db,
      [{ chatId: "100", html: "<b>Broadcast</b>", disableNotification: false }],
      1000,
      { sourceType: "admin_broadcast", priority: TELEGRAM_PENDING_PRIORITY.adminBroadcast },
    );

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"));
    expect(insert).toBeDefined();
    expect(insert?.binds).toContain(TELEGRAM_PENDING_PRIORITY.adminBroadcast);
    expect(insert?.binds).toContain("admin_broadcast");
  });

  it("does nothing for empty message list", async () => {
    const db = mockD1([]);
    await enqueuePendingAlerts(db, [], 1000);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("resets not_before_at on the stale-row re-enqueue path", async () => {
    // P1.6 regression: a stale row whose prior life ended in a rate-limit
    // defer should not stay held back after a fresh start. The upsert refresh
    // predicate must also cover rows whose source-specific TTL already expired.
    const db = mockD1([
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
    ]);

    const nowSec = 10_000;

    await enqueuePendingAlerts(
      db,
      [{ chatId: "stale-chat", html: "<b>Fresh</b>", disableNotification: false }],
      nowSec,
    );

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"));
    expect(insert).toBeDefined();
    // The new CASE branch must come first so it takes precedence over the
    // existing MAX/COALESCE logic when the prior row is stale.
    expect(insert!.sql.replace(/\s+/g, " ")).toContain(
      `not_before_at = CASE WHEN COALESCE( telegram_pending_alerts.expires_at,`
      + ` telegram_pending_alerts.created_at + ${PENDING_TTL_SEC} ) <= excluded.created_at`
      + ` OR telegram_pending_alerts.created_at < excluded.created_at - ${PENDING_TTL_SEC}`
      + ` THEN excluded.not_before_at`,
    );
    // The TTL constant is inlined into the generated predicate, so the
    // statement binds only its eighteen insert values.
    expect(insert!.binds).toHaveLength(18);
  });

  it("refreshes expired short-TTL rows on re-enqueue before the one-hour stale cutoff", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    try {
      const msg = { chatId: "admin-chat", html: "<b>Broadcast</b>", disableNotification: false };
      await enqueuePendingAlerts(db, [msg], 1_000, {
        sourceType: "admin_broadcast",
        priority: TELEGRAM_PENDING_PRIORITY.adminBroadcast,
        ttlSec: 30 * 60,
      });
      const dedupeKey = buildDedupeKey(msg);
      sqlite
        .prepare(
          `UPDATE telegram_pending_alerts
              SET attempts = 5,
                  not_before_at = 5000,
                  last_error_class = 'rate_limit',
                  retry_after_sec = 300,
                  processing_owner = 'old-owner',
                  processing_started_at = 1100,
                  processing_expires_at = 5100
            WHERE dedupe_key = ?`,
        )
        .run(dedupeKey);

      await enqueuePendingAlerts(db, [msg], 2_900, {
        sourceType: "admin_broadcast",
        priority: TELEGRAM_PENDING_PRIORITY.adminBroadcast,
        ttlSec: 30 * 60,
      });

      const row = sqlite
        .prepare(
          `SELECT created_at, attempts, not_before_at, expires_at, processing_owner,
                  processing_started_at, processing_expires_at
             FROM telegram_pending_alerts
            WHERE dedupe_key = ?`,
        )
        .get(dedupeKey) as {
          created_at: number;
          attempts: number;
          not_before_at: number | null;
          expires_at: number | null;
          processing_owner: string | null;
          processing_started_at: number | null;
          processing_expires_at: number | null;
        };

      expect(row).toEqual({
        created_at: 2_900,
        attempts: 0,
        not_before_at: null,
        expires_at: 4_700,
        processing_owner: null,
        processing_started_at: null,
        processing_expires_at: null,
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("readPendingCapacitySnapshot", () => {
  it("normalizes pending capacity metrics and estimates drain time", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "delivery_state = 'pending' THEN 1 ELSE 0 END) AS total",
        first: {
          total: 80,
          expired: 5,
          due: 40,
          deferred: 35,
          near_ttl: 3,
          oldest_pending_created_at: now - 1200,
          oldest_due_created_at: now - 900,
        },
        rows: [],
      },
    ]);

    const snapshot = await readPendingCapacitySnapshot(db, now, TELEGRAM_PENDING_DRAIN_BUDGET);

    expect(snapshot).toMatchObject({
      total: 80,
      active: 75,
      due: 40,
      deferred: 35,
      expired: 5,
      nearTtl: 3,
      oldestPendingAgeSec: 1200,
      oldestDuePendingAgeSec: 900,
    });
    expect(snapshot.estimatedDrainTimeSec).toBe(
      estimateTelegramDrainTimeSec(75, TELEGRAM_PENDING_DRAIN_BUDGET),
    );
  });

  it("excludes expired execution-unknown rows from active delivery-risk capacity", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    try {
      insertPendingSqlite(sqlite, {
        id: 9101,
        chatId: "expired-unknown",
        html: "<b>Expired unknown</b>",
        createdAt: now - PENDING_TTL_SEC - 120,
        expiresAt: now - 60,
      });
      insertPendingSqlite(sqlite, {
        id: 9102,
        chatId: "active-unknown",
        html: "<b>Active unknown</b>",
        createdAt: now - 1200,
        expiresAt: now + 60,
      });
      sqlite.prepare(`
        UPDATE telegram_pending_alerts
           SET delivery_state = 'execution_unknown',
               delivery_started_at = created_at,
               delivery_completed_at = created_at
         WHERE id IN (9101, 9102)
      `).run();

      const snapshot = await readPendingCapacitySnapshot(db, now);

      expect(snapshot.pendingExecutionUnknown).toBe(1);
      expect(snapshot.executionUnknown).toBe(1);
      expect(snapshot.oldestExecutionUnknownAgeSec).toBe(1200);
    } finally {
      sqlite.close();
    }
  });
});

describe("buildDedupeKey", () => {
  const canonicalHtml = "<b>Pharos Alerts</b>\n\nDEWS\nUSDC: ALERT → WATCH";

  it("produces the same key across runs for the same canonical body", () => {
    const a = buildDedupeKey({ chatId: "100", html: "post-split-chunk-A", canonicalHtml, disableNotification: false, chunkIndex: 0 });
    const b = buildDedupeKey({ chatId: "100", html: "different-post-split-chunk", canonicalHtml, disableNotification: false, chunkIndex: 0 });
    // Same canonical body + chunk index + split version => same key, regardless
    // of how splitMessage chopped the chunk html.
    expect(a).toBe(b);
  });

  it("produces a new key when the split version is bumped", () => {
    const v1 = buildDedupeKey(
      { chatId: "100", html: "chunk", canonicalHtml, disableNotification: false, chunkIndex: 0 },
      TELEGRAM_SPLIT_VERSION,
    );
    const v2 = buildDedupeKey(
      { chatId: "100", html: "chunk", canonicalHtml, disableNotification: false, chunkIndex: 0 },
      TELEGRAM_SPLIT_VERSION + 1,
    );
    expect(v1).not.toBe(v2);
  });

  it("produces a different key for each chunk index of the same canonical body", () => {
    const chunk0 = buildDedupeKey({ chatId: "100", html: "c0", canonicalHtml, disableNotification: false, chunkIndex: 0 });
    const chunk1 = buildDedupeKey({ chatId: "100", html: "c1", canonicalHtml, disableNotification: false, chunkIndex: 1 });
    const chunk2 = buildDedupeKey({ chatId: "100", html: "c2", canonicalHtml, disableNotification: false, chunkIndex: 2 });
    expect(new Set([chunk0, chunk1, chunk2]).size).toBe(3);
  });
});

describe("loadChatsInBackoff", () => {
  it("returns the max not_before_at by chat for pending rows in backoff", async () => {
    const nowSec = 5000;
    const db = mockD1([
      {
        match: "SELECT chat_id, MAX(not_before_at)",
        rows: [{ chat_id: "chat-A", not_before_at: 5100 }, { chat_id: "chat-B", not_before_at: 5300 }],
      },
    ]);

    const result = await loadChatsInBackoff(db, nowSec);
    expect(result).toEqual(new Map([["chat-A", 5100], ["chat-B", 5300]]));

    const history = db.getHistory();
    const select = history.find((entry) => entry.sql.includes("SELECT chat_id, MAX(not_before_at)"));
    expect(select?.sql).toContain("not_before_at IS NOT NULL");
    expect(select?.sql).toContain("COALESCE(expires_at, created_at + ?) > ?");
    expect(select?.sql).toContain("not_before_at > ?");
    expect(select?.sql).toContain("GROUP BY chat_id");
    expect(select?.binds).toEqual([PENDING_TTL_SEC, nowSec, nowSec]);
  });

  it("returns an empty set when no rows are in backoff", async () => {
    const db = mockD1([
      { match: "SELECT chat_id, MAX(not_before_at)", rows: [] },
    ]);
    expect(await loadChatsInBackoff(db, 1000)).toEqual(new Map());
  });

  it("does not report TTL-expired short-TTL rows as in backoff but does report unexpired ones", async () => {
    // P1.8 regression: filter on COALESCE(expires_at, created_at + PENDING_TTL_SEC) > nowSec
    // (matching the capacity.ts idiom), not on created_at + PENDING_TTL_SEC. A 30-min-TTL
    // launch/admin row that has expired but not yet been swept must not surface as
    // "in backoff"; a genuinely-future expires_at row on the same chat must.
    const nowSec = 5000;
    const db = mockD1([
      {
        match: "SELECT chat_id, MAX(not_before_at)",
        // The mock returns whatever it is seeded; this fixture asserts on the SQL
        // shape and bind values that drive the actual D1 filter.
        rows: [{ chat_id: "fresh-chat", not_before_at: nowSec + 120 }],
      },
    ]);

    const result = await loadChatsInBackoff(db, nowSec);
    expect(result).toEqual(new Map([["fresh-chat", nowSec + 120]]));

    const select = db.getHistory().find((entry) =>
      entry.sql.includes("SELECT chat_id, MAX(not_before_at)"),
    );
    // Buggy form filtered by `created_at >= nowSec - PENDING_TTL_SEC`, which would
    // include rows whose 30-min expires_at had already passed.
    expect(select?.sql).not.toContain("created_at >= ?");
    expect(select?.sql).toContain("COALESCE(expires_at, created_at + ?) > ?");
    expect(select?.binds).toEqual([PENDING_TTL_SEC, nowSec, nowSec]);
  });
});

describe("cleanupExpiredPendingAlerts", () => {
  it("retries deletion after a committed dead-letter insert without duplicating audit rows", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, {
      id: 901,
      chatId: "dead-letter-crash",
      html: "<b>Expired</b>",
      createdAt: now - PENDING_TTL_SEC - 10,
      expiresAt: now - 1,
      dedupeKey: "dead-letter-crash-key",
    });
    let failDelete = true;
    const crashDb = {
      ...db,
      prepare: (sql: string) => {
        if (sql.includes("DELETE FROM telegram_pending_alerts WHERE id IN")) {
          const statement = db.prepare(sql);
          return {
            bind: (...binds: unknown[]) => {
              const bound = statement.bind(...binds);
              return {
                run: async () => {
                  if (failDelete) {
                    failDelete = false;
                    throw new Error("crash after dead-letter insert");
                  }
                  return bound.run();
                },
              };
            },
          } as unknown as D1PreparedStatement;
        }
        return db.prepare(sql);
      },
    } as D1Database;

    await expect(cleanupExpiredPendingAlerts(crashDb, now)).rejects.toThrow("crash after dead-letter insert");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_dead_letters").get()).toEqual({ count: 1 });
    await expect(cleanupExpiredPendingAlerts(crashDb, now + 1)).resolves.toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_dead_letters").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT id FROM telegram_pending_alerts WHERE id = 901").get()).toBeUndefined();
    sqlite.close();
  });

  it("keeps repeated manual clear idempotent after delete failure", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, {
      id: 902,
      chatId: "manual-clear-crash",
      html: "<b>Manual</b>",
      createdAt: now - 60,
      expiresAt: now + 600,
      dedupeKey: "manual-clear-crash-key",
    });
    let failDelete = true;
    const crashDb = {
      ...db,
      prepare: (sql: string) => {
        if (sql.includes("DELETE FROM telegram_pending_alerts WHERE id IN")) {
          const statement = db.prepare(sql);
          return {
            bind: (...binds: unknown[]) => {
              const bound = statement.bind(...binds);
              return {
                run: async () => {
                  if (failDelete) {
                    failDelete = false;
                    throw new Error("manual delete failed");
                  }
                  return bound.run();
                },
              };
            },
          } as unknown as D1PreparedStatement;
        }
        return db.prepare(sql);
      },
    } as D1Database;

    await expect(clearPendingAlertsForAdmin(crashDb, { chatId: "manual-clear-crash" }, now))
      .rejects.toThrow("manual delete failed");
    await expect(clearPendingAlertsForAdmin(crashDb, { chatId: "manual-clear-crash" }, now + 1))
      .resolves.toBe(1);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count, MIN(reason) AS reason FROM telegram_alert_dead_letters WHERE pending_id = 902",
    ).get()).toEqual({ count: 1, reason: "manual_clear" });
    sqlite.close();
  });

  it("keeps sending and execution-unknown rows out of ordinary admin clear", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    for (const [id, state] of [[910, "pending"], [911, "sending"], [912, "execution_unknown"]] as const) {
      insertPendingSqlite(sqlite, {
        id,
        chatId: "admin-clear-lifecycle",
        html: `<b>${state}</b>`,
        createdAt: now - 60,
        expiresAt: now + 600,
        dedupeKey: `admin-clear-${state}`,
      });
      sqlite.prepare(
        `UPDATE telegram_pending_alerts
            SET delivery_state = ?, delivery_owner = ?, delivery_generation = 1
          WHERE id = ?`,
      ).run(state, state === "pending" ? null : `${state}-owner`, id);
    }

    await expect(countPendingAlertsForAdmin(db, { chatId: "admin-clear-lifecycle" })).resolves.toBe(1);
    await expect(clearPendingAlertsForAdmin(db, { chatId: "admin-clear-lifecycle" }, now)).resolves.toBe(1);
    expect(sqlite.prepare(
      "SELECT id, delivery_state FROM telegram_pending_alerts ORDER BY id",
    ).all()).toEqual([
      { id: 911, delivery_state: "sending" },
      { id: 912, delivery_state: "execution_unknown" },
    ]);
    sqlite.close();
  });

  it("archives 90-day execution-unknown rows but CAS-preserves operator resolutions", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, {
      id: 903,
      chatId: "unknown-retention",
      html: "<b>Unknown</b>",
      createdAt: now - 91 * 24 * 60 * 60,
      expiresAt: now - 90 * 24 * 60 * 60,
      dedupeKey: "unknown-retention-key",
    });
    sqlite.prepare(
      `UPDATE telegram_pending_alerts
          SET delivery_state = 'execution_unknown', delivery_owner = 'unknown-owner',
              delivery_generation = 2, delivery_started_at = ?, delivery_completed_at = ?
        WHERE id = 903`,
    ).run(now - 91 * 24 * 60 * 60, now - 91 * 24 * 60 * 60);
    let resolved = false;
    const racingDb = {
      ...db,
      prepare: (sql: string) => {
        if (!resolved && sql.includes("DELETE FROM telegram_pending_alerts") && sql.includes("delivery_state = 'execution_unknown'")) {
          resolved = true;
          sqlite.prepare(
            `UPDATE telegram_pending_alerts
                SET delivery_state = 'sent', delivery_owner = 'operator',
                    delivery_generation = delivery_generation + 1
              WHERE id = 903`,
          ).run();
        }
        return db.prepare(sql);
      },
    } as D1Database;

    await expect(archiveAgedExecutionUnknownPendingAlerts(racingDb, now)).resolves.toBe(0);
    expect(sqlite.prepare(
      "SELECT delivery_state, delivery_owner, delivery_generation FROM telegram_pending_alerts WHERE id = 903",
    ).get()).toEqual({ delivery_state: "sent", delivery_owner: "operator", delivery_generation: 3 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_dead_letters WHERE pending_id = 903").get())
      .toEqual({ count: 1 });
    sqlite.close();
  });

  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("deletes alerts older than PENDING_TTL_SEC", async () => {
    const nowSec = 5000;
    const expiredRows = [1, 2, 3].map((id) => ({
      id,
      chat_id: `chat-${id}`,
      message_html: "<b>Expired</b>",
      created_at: nowSec - PENDING_TTL_SEC - 1,
      attempts: 0,
      last_error_class: null,
      dedupe_key: `key-${id}`,
      chunk_index: 0,
      priority: TELEGRAM_PENDING_PRIORITY.legacy,
      source_type: "risk_alert",
      alert_type: "depeg",
    }));
    const db = mockD1([
      { match: "SELECT id, chat_id, message_html", rows: expiredRows },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [], runMeta: { changes: 3 } },
    ]);

    const expired = await cleanupExpiredPendingAlerts(db, nowSec);
    expect(expired).toBe(3);

    const history = db.getHistory();
    const selectCall = history.find((e) => e.sql.includes("FROM telegram_pending_alerts"));
    expect(selectCall?.sql).toContain("COALESCE(expires_at, created_at + ?) <= ?");
    expect(selectCall?.sql).toContain("LIMIT ?");
    expect(selectCall?.binds).toEqual([
      PENDING_TTL_SEC,
      nowSec,
      EXPIRED_PENDING_CLEANUP_BATCH_LIMIT,
    ]);
    expect(selectCall?.binds[selectCall.binds.length - 1]).toBe(EXPIRED_PENDING_CLEANUP_BATCH_LIMIT);
    const deleteCall = history.find((e) => e.sql.includes("DELETE FROM telegram_pending_alerts"));
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.binds).toEqual([1, 2, 3]);
  });

  it("caps expired cleanup work to one batch per run", async () => {
    const nowSec = 5000;
    const expiredRows = Array.from({ length: EXPIRED_PENDING_CLEANUP_BATCH_LIMIT }, (_, index) => ({
      id: index + 1,
      chat_id: `chat-${index + 1}`,
      message_html: "<b>Expired</b>",
      created_at: nowSec - PENDING_TTL_SEC - 1,
      attempts: 0,
      last_error_class: null,
      dedupe_key: `key-${index + 1}`,
      chunk_index: 0,
      priority: TELEGRAM_PENDING_PRIORITY.legacy,
      source_type: "risk_alert",
      alert_type: "depeg",
    }));
    const db = mockD1([
      { match: "SELECT id, chat_id, message_html", rows: expiredRows },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      {
        match: "DELETE FROM telegram_pending_alerts WHERE id IN",
        rows: [],
        runMeta: { changes: EXPIRED_PENDING_CLEANUP_BATCH_LIMIT },
      },
    ]);

    expect(await cleanupExpiredPendingAlerts(db, nowSec)).toBe(EXPIRED_PENDING_CLEANUP_BATCH_LIMIT);

    const selectCall = db.getHistory().find((entry) => entry.sql.includes("FROM telegram_pending_alerts"));
    expect(selectCall?.binds).toEqual([
      PENDING_TTL_SEC,
      nowSec,
      EXPIRED_PENDING_CLEANUP_BATCH_LIMIT,
    ]);
    expect(
      parseLogRecords(infoSpy).some((record) =>
        record.action === "cleanup-expired-pending-alert-capped" &&
        record.cappedAtLimit === EXPIRED_PENDING_CLEANUP_BATCH_LIMIT
      ),
    ).toBe(true);
  });

  it("preserves rows whose explicit expires_at extends beyond the default TTL", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    try {
      const nowSec = 5_000;
      insertPendingSqlite(sqlite, {
        id: 1,
        chatId: "long-expiry-chat",
        html: "<b>Still live</b>",
        createdAt: nowSec - PENDING_TTL_SEC - 60,
        dedupeKey: "long-expiry-key",
        expiresAt: nowSec + 600,
      });
      insertPendingSqlite(sqlite, {
        id: 2,
        chatId: "default-expired-chat",
        html: "<b>Default expired</b>",
        createdAt: nowSec - PENDING_TTL_SEC - 60,
        dedupeKey: "default-expired-key",
        expiresAt: null,
      });
      insertPendingSqlite(sqlite, {
        id: 3,
        chatId: "explicit-expired-chat",
        html: "<b>Explicit expired</b>",
        createdAt: nowSec - 60,
        dedupeKey: "explicit-expired-key",
        expiresAt: nowSec - 1,
      });

      expect(await cleanupExpiredPendingAlerts(db, nowSec)).toBe(2);

      expect(
        sqlite
          .prepare("SELECT id, chat_id FROM telegram_pending_alerts ORDER BY id ASC")
          .all(),
      ).toEqual([{ id: 1, chat_id: "long-expiry-chat" }]);
      expect(
        sqlite
          .prepare("SELECT pending_id, reason FROM telegram_alert_dead_letters ORDER BY pending_id ASC")
          .all(),
      ).toEqual([
        { pending_id: 2, reason: "ttl_expired" },
        { pending_id: 3, reason: "ttl_expired" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("logs each expired cleanup row with TTL and prior failure reason classes", async () => {
    const nowSec = 5000;
    const db = mockD1([
      {
        match: "SELECT id, chat_id, message_html",
        rows: [
          {
            id: 10,
            chat_id: "default-ttl-chat",
            message_html: "<b>Default TTL</b>",
            created_at: nowSec - PENDING_TTL_SEC - 5,
            expires_at: null,
            attempts: 0,
            last_error_class: null,
            dedupe_key: "default-key",
            chunk_index: 0,
            priority: TELEGRAM_PENDING_PRIORITY.depeg,
            source_type: "risk_alert",
            alert_type: "depeg",
          },
          {
            id: 11,
            chat_id: "explicit-ttl-chat",
            message_html: "<b>Explicit TTL</b>",
            created_at: nowSec - 30,
            expires_at: nowSec - 1,
            attempts: 2,
            last_error_class: "bad_request",
            dedupe_key: "explicit-key",
            chunk_index: 1,
            priority: TELEGRAM_PENDING_PRIORITY.launch,
            source_type: "risk_alert",
            alert_type: "launch",
          },
        ],
      },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [], runMeta: { changes: 2 } },
    ]);

    expect(await cleanupExpiredPendingAlerts(db, nowSec)).toBe(2);

    const logs = parseLogRecords(infoSpy).filter((record) =>
      record.action === "cleanup-expired-pending-alert"
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      scope: "telegram",
      level: "info",
      module: "telegram-pending-cleanup",
      reason: "ttl_expired",
      rowCount: 2,
      affectedChatCount: 2,
      dedupeKeyCount: 2,
      ageSec: PENDING_TTL_SEC + 5,
    });
    expect(JSON.stringify(logs)).not.toContain("default-ttl-chat");
    expect(JSON.stringify(logs)).not.toContain("explicit-ttl-chat");
  });

  it("dead-letters expired rows without bumping the subscriber block-strike counter", async () => {
    const nowSec = 5000;
    const db = mockD1([
      {
        match: "SELECT id, chat_id, message_html",
        rows: [{
          id: 44,
          chat_id: "expired-blocked",
          message_html: "<b>Expired blocked row</b>",
          created_at: nowSec - PENDING_TTL_SEC - 1,
          attempts: 1,
          last_error_class: "blocked",
          dedupe_key: "expired-blocked-key",
          chunk_index: 0,
          priority: TELEGRAM_PENDING_PRIORITY.depeg,
          source_type: "risk_alert",
          alert_type: "depeg",
        }],
      },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [], runMeta: { changes: 1 } },
    ]);

    expect(await cleanupExpiredPendingAlerts(db, nowSec)).toBe(1);

    const history = db.getHistory();
    const deadLetter = history.find((entry) =>
      entry.sql.includes("INSERT INTO telegram_alert_dead_letters")
    );
    expect(deadLetter?.binds[10]).toBe("blocked");
    expect(deadLetter?.binds[11]).toBe("ttl_expired");
    expect(history.some((entry) => entry.sql.includes("SELECT consecutive_block_count"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("UPDATE telegram_subscribers"))).toBe(false);
  });

  it("returns 0 when no alerts expired", async () => {
    const db = mockD1([
      { match: "SELECT id, chat_id, message_html", rows: [] },
    ]);
    expect(await cleanupExpiredPendingAlerts(db, 5000)).toBe(0);
  });

  it("deletes expired alerts with an error log when dead-lettering fails", async () => {
    const nowSec = 5000;
    const db = mockD1([
      {
        match: "SELECT id, chat_id, message_html",
        rows: [{
          id: 1,
          chat_id: "chat-1",
          message_html: "<b>Expired</b>",
          created_at: nowSec - PENDING_TTL_SEC - 1,
          attempts: 0,
          last_error_class: null,
          dedupe_key: "key-1",
          chunk_index: 0,
          priority: TELEGRAM_PENDING_PRIORITY.legacy,
          source_type: "risk_alert",
          alert_type: "depeg",
        }],
      },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [], throwError: new Error("D1 write failed") },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [], runMeta: { changes: 1 } },
    ]);

    expect(await cleanupExpiredPendingAlerts(db, nowSec)).toBe(1);
    expect(db.getHistory().some((entry) =>
      entry.sql.includes("DELETE FROM telegram_pending_alerts")
    )).toBe(true);
    const errorRecords = parseLogRecords(errorSpy);
    expect(errorRecords).toContainEqual(
      expect.objectContaining({
        scope: "telegram",
        level: "error",
        module: "telegram-pending-cleanup",
        action: "cleanup-expired-pending-dead-letter-bypass",
        reason: "ttl_expired",
        rowCount: 1,
        affectedChatCount: 1,
        dedupeKeyCount: 1,
      }),
    );
  });
});
