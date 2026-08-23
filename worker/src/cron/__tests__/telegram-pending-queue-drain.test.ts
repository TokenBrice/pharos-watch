import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mockD1 as createMockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import {
  serializePendingAlertScope,
  serializePendingMarkupPolicy,
} from "../../lib/telegram-pending-provenance";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  DEFAULT_TELEGRAM_PENDING_D1_TABLES,
  insertPendingSqlite,
  makeTelegramDeliveryResult,
} from "./telegram-pending-queue.test-support";

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
  drainPendingQueue,
  cleanupExpiredPendingAlerts,
  pendingBackoffSec,
  PENDING_TTL_SEC,
  PENDING_MAX_ATTEMPTS,
  PENDING_BACKOFF_SCHEDULE_SEC,
  BLOCK_STRIKE_WINDOW_SEC,
  TELEGRAM_PENDING_PRIORITY,
  TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY,
  SEND_BATCH_SIZE,
  PENDING_CLAIM_TTL_SEC,
  reconcileStalePendingSending,
} = await import("../telegram-pending");
const { enqueuePendingAlerts, buildDedupeKey } = await import("../../lib/telegram-pending-queue");
await import("../../lib/telegram-alerts");

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

describe("drainPendingQueue", () => {
  function insertRecapDeliveryFixture(
    sqlite: DatabaseSync,
    now: number,
    options: { chatId?: string; generation?: number; paused?: boolean } = {},
  ): { chatId: string; recapKey: string } {
    const chatId = options.chatId ?? "recap-delivery";
    const generation = options.generation ?? 4;
    const recapKey = `recap:${chatId}:2026-07-11:v1`;
    insertSubscriberSqlite(sqlite, {
      chatId,
      preferenceGeneration: generation,
      alertSnoozeUntilTs: options.paused ? 4_102_444_800 : null,
    });
    sqlite.prepare(
      `INSERT INTO telegram_recap_preferences
       (chat_id, chat_kind, enabled, last_window_end_at, last_delivered_local_date, created_at, updated_at)
       VALUES (?, 'private', 1, NULL, NULL, ?, ?)`,
    ).run(chatId, now, now);
    sqlite.prepare(
      `INSERT INTO telegram_recap_targets
       (recap_key, chat_id, local_date, window_start_at, window_end_at, preference_generation,
        watchlist_fingerprint, pending_dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, '2026-07-11', ?, ?, ?, 'fingerprint-v1', ?, 'queued', ?, ?)`,
    ).run(recapKey, chatId, now - 3660, now - 60, generation, recapKey, now, now);
    insertPendingSqlite(sqlite, {
      id: options.paused ? 8_502 : 8_501,
      chatId,
      html: "<b>Your Watchbot recap</b>",
      createdAt: now - 30,
      expiresAt: now + 3600,
      priority: 100,
      sourceType: "personalized_recap",
      dedupeKey: recapKey,
      sourceEventId: recapKey,
      preferenceGeneration: generation,
      markupPolicyJson: serializePendingMarkupPolicy({
        replyMarkup: { inline_keyboard: [[{ text: "View watchlist", web_app: { url: "https://pharos.watch/pharoswatchbot" } }]] },
      }),
    });
    return { chatId, recapKey };
  }

  it("projects an accepted personalized recap and replays its persisted Mini App markup", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    const { chatId, recapKey } = insertRecapDeliveryFixture(sqlite, now);
    mockSendToChat.mockResolvedValue({
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    });

    await expect(drainPendingQueue(db, "bot-token", 1)).resolves.toMatchObject({ sent: 1 });
    expect(mockSendToChat).toHaveBeenCalledWith(
      chatId,
      "<b>Your Watchbot recap</b>",
      "bot-token",
      expect.objectContaining({ replyMarkup: expect.objectContaining({ inline_keyboard: expect.any(Array) }) }),
    );
    expect(sqlite.prepare(
      "SELECT status FROM telegram_recap_targets WHERE recap_key = ?",
    ).get(recapKey)).toEqual({ status: "sent" });
    expect(sqlite.prepare(
      "SELECT last_window_end_at, last_delivered_local_date FROM telegram_recap_preferences WHERE chat_id = ?",
    ).get(chatId)).toEqual({ last_window_end_at: now - 60, last_delivered_local_date: "2026-07-11" });
    sqlite.close();
  });

  it("cancels a paused personalized recap before the Bot API effect", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    const { recapKey } = insertRecapDeliveryFixture(sqlite, now, { paused: true });

    await expect(drainPendingQueue(db, "bot-token", 1)).resolves.toMatchObject({ attempted: 0, dropped: 1 });
    expect(mockSendToChat).not.toHaveBeenCalled();
    expect(sqlite.prepare(
      "SELECT status, terminal_reason FROM telegram_recap_targets WHERE recap_key = ?",
    ).get(recapKey)).toEqual({ status: "cancelled", terminal_reason: "recap_paused" });
    sqlite.close();
  });

  it("cancels a newly ineligible risk target without attempting the Bot API", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertSubscriberSqlite(sqlite, {
      chatId: "preference-cancel",
      preferenceGeneration: 2,
      globalAlertDews: 0,
    });
    const scopeJson = serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]);
    const markupJson = serializePendingMarkupPolicy({});
    insertPendingSqlite(sqlite, {
      id: 801,
      chatId: "preference-cancel",
      html: "<b>Cancelled</b>",
      createdAt: now - 60,
      expiresAt: now + 600,
      priority: TELEGRAM_PENDING_PRIORITY.dews,
      sourceType: "risk_alert",
      alertType: "dews",
      dedupeKey: "preference-cancel-key",
      sourceEventId: "source-cancel",
      alertScopeJson: scopeJson,
      preferenceGeneration: 1,
      markupPolicyJson: markupJson,
    });
    sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, alert_type,
         pending_dedupe_key, status, created_at, effect_state
       ) VALUES ('preference-cancel-job', 'preference-cancel-target', 'preference-cancel', 'dews',
                 'preference-cancel-key', 'queued', ?, 'unstarted')`,
    ).run(now - 60);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result).toMatchObject({ attempted: 0, sent: 0, dropped: 1 });
    expect(mockSendToChat).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT id FROM telegram_pending_alerts WHERE id = 801").get()).toBeUndefined();
    expect(sqlite.prepare(
      `SELECT reason, last_error_class, source_event_id, alert_scope_json,
              preference_generation, markup_policy_json
         FROM telegram_alert_dead_letters WHERE pending_id = 801`,
    ).get()).toEqual({
      reason: "preference_changed",
      last_error_class: "scope_disabled",
      source_event_id: "source-cancel",
      alert_scope_json: scopeJson,
      preference_generation: 1,
      markup_policy_json: markupJson,
    });
    expect(sqlite.prepare(
      `SELECT status, error_class, cancelled_at, cancellation_reason
         FROM telegram_alert_job_targets WHERE pending_dedupe_key = 'preference-cancel-key'`,
    ).get()).toEqual({
      status: "failed",
      error_class: "preference_changed",
      cancelled_at: now,
      cancellation_reason: "scope_disabled",
    });
    sqlite.close();
  });

  it("skips the Bot API when preference generation changes after revalidation", async () => {
    const { sqlite } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertSubscriberSqlite(sqlite, {
      chatId: "generation-race",
      preferenceGeneration: 1,
      globalAlertDews: 1,
    });
    insertPendingSqlite(sqlite, {
      id: 802,
      chatId: "generation-race",
      html: "<b>Race</b>",
      createdAt: now - 60,
      expiresAt: now + 600,
      priority: TELEGRAM_PENDING_PRIORITY.dews,
      sourceType: "risk_alert",
      alertType: "dews",
      dedupeKey: "generation-race-key",
      sourceEventId: "source-race",
      alertScopeJson: serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]),
      preferenceGeneration: 1,
      markupPolicyJson: serializePendingMarkupPolicy({}),
    });
    let bumped = false;
    const db = createSqliteD1(sqlite, { onAll: (sql) => {
      if (!bumped && sql.includes("FROM telegram_subscriptions")) {
        bumped = true;
        sqlite.prepare(
          `UPDATE telegram_subscribers
              SET preference_generation = preference_generation + 1
            WHERE chat_id = 'generation-race'`,
        ).run();
      }
    } });

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(bumped).toBe(true);
    expect(result).toMatchObject({ attempted: 0, sent: 0, deferred: 1, dropped: 0 });
    expect(mockSendToChat).not.toHaveBeenCalled();
    expect(sqlite.prepare(
      `SELECT delivery_state, processing_owner, last_error_class,
              preference_generation AS enqueue_generation
         FROM telegram_pending_alerts WHERE id = 802`,
    ).get()).toEqual({
      delivery_state: "pending",
      processing_owner: null,
      last_error_class: "preference_generation_changed",
      enqueue_generation: 1,
    });
    sqlite.close();
  });

  it("replays persisted markup after unchanged-generation validation", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    const replyMarkup = {
      inline_keyboard: [[{ text: "Snooze 1h", callback_data: "snooze:1h" }]],
    };
    const linkPreviewOptions = {
      url: "https://pharos.watch/stablecoin/usdc-circle",
      prefer_small_media: true,
    };
    insertSubscriberSqlite(sqlite, {
      chatId: "markup-replay",
      preferenceGeneration: 5,
      globalAlertDews: 1,
    });
    insertPendingSqlite(sqlite, {
      id: 803,
      chatId: "markup-replay",
      html: "<b>Markup</b>",
      createdAt: now - 60,
      expiresAt: now + 600,
      priority: TELEGRAM_PENDING_PRIORITY.dews,
      sourceType: "risk_alert",
      alertType: "dews",
      dedupeKey: "markup-replay-key",
      sourceEventId: "source-markup",
      alertScopeJson: serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]),
      preferenceGeneration: 5,
      markupPolicyJson: serializePendingMarkupPolicy({ replyMarkup, linkPreviewOptions }),
    });
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

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result).toMatchObject({ attempted: 1, sent: 1, deferred: 0 });
    expect(mockSendToChat).toHaveBeenCalledWith(
      "markup-replay",
      "<b>Markup</b>",
      "bot-token",
      expect.objectContaining({
        disableWebPagePreview: true,
        replyMarkup,
        linkPreviewOptions,
      }),
    );
    sqlite.close();
  });

  it("reconciles completed send results even if the signal aborts after Telegram accepts delivery", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    insertSubscriberSqlite(sqlite, {
      chatId: "post-send-abort",
      preferenceGeneration: 1,
      globalAlertDews: 1,
    });
    insertPendingSqlite(sqlite, {
      id: 804,
      chatId: "post-send-abort",
      html: "<b>Delivered before abort</b>",
      createdAt: now - 60,
      expiresAt: now + 600,
      priority: TELEGRAM_PENDING_PRIORITY.dews,
      sourceType: "risk_alert",
      alertType: "dews",
      dedupeKey: "post-send-abort-key",
      sourceEventId: "source-post-send-abort",
      alertScopeJson: serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]),
      preferenceGeneration: 1,
      markupPolicyJson: serializePendingMarkupPolicy({}),
    });
    mockSendToChat.mockImplementation(async () => {
      controller.abort("slot deadline after Telegram accepted send");
      return {
        ok: true,
        blocked: false,
        retryable: false,
        permanentFailure: false,
        statusCode: 200,
        errorClass: null,
        delivery: "sent",
        retryAfterSec: null,
      };
    });

    const result = await drainPendingQueue(db, "bot-token", 10, controller.signal);

    expect(result).toMatchObject({ attempted: 1, sent: 1, deferred: 0, retryQueued: 0 });
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT id FROM telegram_pending_alerts WHERE id = 804").get()).toBeUndefined();
    sqlite.close();
  });

  it("checkpoints a completed wave before the next wave can become execution-unknown", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const initialNow = Math.floor(Date.now() / 1000);
    const sourceEventId = "source-wave-checkpoint";
    const jobId = "job-wave-checkpoint";
    const okResult = {
      ok: true,
      blocked: false,
      retryable: false,
      permanentFailure: false,
      statusCode: 200,
      errorClass: null,
      delivery: "sent" as const,
      retryAfterSec: null,
    };
    let sendCalls = 0;
    let resolveInFlight: (() => void) | undefined;

    insertSourceEventSqlite(sqlite, {
      sourceEventId,
      planGeneration: 1,
      detectedAt: initialNow - 100,
      expiresAt: initialNow + 3_600,
    });
    sqlite.prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at,
         status, target_count, enqueued_count, metadata
       ) VALUES (?, 'dews', ?, 'warning', ?, ?, 'queued', 5, 5, '{}')`,
    ).run(jobId, sourceEventId, initialNow, initialNow + 3_600);
    for (let index = 0; index < 5; index++) {
      const chatId = `wave-chat-${index}`;
      const dedupeKey = `wave-dedupe-${index}`;
      insertSubscriberSqlite(sqlite, { chatId, preferenceGeneration: 1, globalAlertDews: 1 });
      insertPendingSqlite(sqlite, {
        id: 820 + index,
        chatId,
        html: `<b>Wave ${index}</b>`,
        createdAt: initialNow - 100 + index,
        expiresAt: initialNow + 3_600,
        priority: TELEGRAM_PENDING_PRIORITY.dews,
        sourceType: "risk_alert",
        alertType: "dews",
        dedupeKey,
        sourceEventId,
        alertScopeJson: serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]),
        preferenceGeneration: 1,
        markupPolicyJson: serializePendingMarkupPolicy({}),
      });
      sqlite.prepare(
        `INSERT INTO telegram_alert_job_targets (
           job_id, target_key, chat_id, alert_type, pending_dedupe_key, source_event_id,
           plan_generation, status, created_at
         ) VALUES (?, ?, ?, 'dews', ?, ?, 1, 'queued', ?)`,
      ).run(jobId, dedupeKey, chatId, dedupeKey, sourceEventId, initialNow);
    }

    mockSendToChat.mockImplementation(() => {
      sendCalls += 1;
      if (sendCalls === SEND_BATCH_SIZE) {
        vi.setSystemTime(new Date((initialNow + 60) * 1_000));
      }
      if (sendCalls <= SEND_BATCH_SIZE) return Promise.resolve(okResult);
      return new Promise((resolve) => {
        resolveInFlight = () => resolve(okResult);
      });
    });

    const drainPromise = drainPendingQueue(db, "bot-token", 5);
    await vi.waitFor(() => expect(mockSendToChat).toHaveBeenCalledTimes(5));

    expect(
      sqlite.prepare(
        `SELECT id, delivery_state, delivery_started_at, delivery_completed_at
           FROM telegram_pending_alerts ORDER BY id`,
      ).all(),
    ).toEqual([
      { id: 820, delivery_state: "sent", delivery_started_at: initialNow, delivery_completed_at: initialNow + 60 },
      { id: 821, delivery_state: "sent", delivery_started_at: initialNow, delivery_completed_at: initialNow + 60 },
      { id: 822, delivery_state: "sent", delivery_started_at: initialNow, delivery_completed_at: initialNow + 60 },
      { id: 823, delivery_state: "sent", delivery_started_at: initialNow, delivery_completed_at: initialNow + 60 },
      { id: 824, delivery_state: "sending", delivery_started_at: initialNow + 60, delivery_completed_at: null },
    ]);
    expect(
      sqlite.prepare(
        `SELECT final_delivery_state, COUNT(*) AS count
           FROM telegram_alert_job_targets
          GROUP BY final_delivery_state
          ORDER BY final_delivery_state`,
      ).all(),
    ).toEqual([
      { final_delivery_state: null, count: 1 },
      { final_delivery_state: "accepted", count: 4 },
    ]);
    expect(
      sqlite.prepare(
        `SELECT status, accepted_count, enqueued_count, execution_unknown_count
           FROM telegram_alert_jobs WHERE job_id = ?`,
      ).get(jobId),
    ).toEqual({ status: "queued", accepted_count: 4, enqueued_count: 1, execution_unknown_count: 0 });

    const staleAt = initialNow + 60 + PENDING_CLAIM_TTL_SEC + 1;
    await expect(reconcileStalePendingSending(db, staleAt)).resolves.toBe(1);
    expect(
      sqlite.prepare(
        `SELECT final_delivery_state, COUNT(*) AS count
           FROM telegram_alert_job_targets
          GROUP BY final_delivery_state
          ORDER BY final_delivery_state`,
      ).all(),
    ).toEqual([
      { final_delivery_state: "accepted", count: 4 },
      { final_delivery_state: "execution_unknown", count: 1 },
    ]);
    expect(
      sqlite.prepare(
        `SELECT status, accepted_count, enqueued_count, execution_unknown_count
           FROM telegram_alert_jobs WHERE job_id = ?`,
      ).get(jobId),
    ).toEqual({ status: "degraded", accepted_count: 4, enqueued_count: 0, execution_unknown_count: 1 });

    resolveInFlight?.();
    await expect(drainPromise).rejects.toThrow("sent-state persistence was not confirmed");
    expect(
      sqlite.prepare(
        `SELECT final_delivery_state, COUNT(*) AS count
           FROM telegram_alert_job_targets
          GROUP BY final_delivery_state
          ORDER BY final_delivery_state`,
      ).all(),
    ).toEqual([
      { final_delivery_state: "accepted", count: 4 },
      { final_delivery_state: "execution_unknown", count: 1 },
    ]);
    sqlite.close();
  });

  it("reports blocked cleanup failures while reconciling results after an abort", async () => {
    const now = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          {
            id: 805,
            chat_id: "post-send-abort-blocked",
            message_html: "<b>Blocked before abort</b>",
            disable_notification: 0,
            created_at: now - 60,
            attempts: 0,
          },
        ],
      },
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 60 }],
      },
      { match: "SET alert_dews=0", rows: [], throwError: new Error("D1 cleanup failed") },
      { match: "INSERT INTO telegram_chat_delivery_diagnostics", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);
    mockSendToChat.mockImplementation(async () => {
      controller.abort("slot deadline after Telegram rejected send");
      return {
        ok: false,
        blocked: true,
        retryable: false,
        permanentFailure: true,
        statusCode: 403,
        errorClass: "blocked",
        delivery: "blocked",
        retryAfterSec: null,
      };
    });

    const result = await drainPendingQueue(db, "bot-token", 10, controller.signal);

    expect(result).toMatchObject({
      attempted: 1,
      blocked: 1,
      blockedCleanedUp: 0,
      blockedCleanupFailed: 1,
    });
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
  });

  it("releases claimed rows without sending when the soft deadline has elapsed", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, {
      id: 1,
      chatId: "deadline-chat",
      html: "<b>Deadline</b>",
      createdAt: now - 60,
      expiresAt: now + 600,
      priority: TELEGRAM_PENDING_PRIORITY.depeg,
      sourceType: "risk_alert",
      alertType: "depeg",
      dedupeKey: "deadline-key",
    });

    const result = await drainPendingQueue(db, "bot-token", 10, undefined, {
      softDeadlineAtMs: Date.now() - 1,
    });

    expect(result.attempted).toBe(0);
    expect(result.sent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare("SELECT processing_owner, processing_started_at, processing_expires_at FROM telegram_pending_alerts WHERE id = 1")
        .get(),
    ).toEqual({
      processing_owner: null,
      processing_started_at: null,
      processing_expires_at: null,
    });
  });

  it("lets only one owner deliver a row when two drains race the same claim", async () => {
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

    const now = Math.floor(Date.now() / 1000);
    const { sqlite } = createLatestSchemaSqlite();
    insertSubscriberSqlite(sqlite, { chatId: "race-chat", globalAlertDepeg: 1 });
    insertPendingSqlite(sqlite, {
      id: 701,
      chatId: "race-chat",
      html: "<b>Race</b>",
      createdAt: now - 30,
      expiresAt: now + 600,
      priority: TELEGRAM_PENDING_PRIORITY.depeg,
      sourceType: "risk_alert",
      alertType: "depeg",
      dedupeKey: "race-key",
    });
    const db = createClaimContentionD1(sqlite);

    const results = await Promise.all([
      drainPendingQueue(db, "bot-token", 1),
      drainPendingQueue(db, "bot-token", 1),
    ]);

    expect(results.map((result) => result.sent).sort()).toEqual([0, 1]);
    expect(results.reduce((sum, result) => sum + result.attempted, 0)).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat).toHaveBeenCalledWith(
      "race-chat",
      "<b>Race</b>",
      "bot-token",
      expect.any(Object),
    );

    const claimUpdates = db.getHistory().filter((entry) =>
      entry.sql.includes("UPDATE telegram_pending_alerts") &&
      entry.sql.includes("SET processing_owner = ?")
    );
    expect(claimUpdates).toHaveLength(2);
    expect(new Set(claimUpdates.map((entry) => entry.binds[0])).size).toBe(2);
    expect(db.getOwner()).toBeTruthy();

    const deletes = db.getHistory().filter((entry) =>
      entry.sql.includes("DELETE FROM telegram_pending_alerts WHERE id IN")
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.binds).toEqual([701]);
  });

  it("does not resend after a successful delivery when pending-row deletion fails", async () => {
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
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, {
      id: 702,
      chatId: "delete-failure-chat",
      html: "<b>Delivered once</b>",
      createdAt: now - 30,
      expiresAt: now + 600,
      dedupeKey: "delete-failure-key",
    });
    const deleteFailingDb = {
      ...db,
      prepare: (sql: string) => {
        if (sql.includes("DELETE FROM telegram_pending_alerts WHERE id IN")) {
          return {
            bind: () => ({ run: async () => { throw new Error("delete failed"); } }),
          } as unknown as D1PreparedStatement;
        }
        return db.prepare(sql);
      },
    } as D1Database;

    const first = await drainPendingQueue(deleteFailingDb, "bot-token", 1);
    expect(first.sent).toBe(1);
    expect(sqlite.prepare("SELECT delivery_state FROM telegram_pending_alerts WHERE id = 702").get())
      .toEqual({ delivery_state: "sent" });

    const second = await drainPendingQueue(db, "bot-token", 1);
    expect(second.attempted).toBe(0);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
  });

  it("reconciles an expired sending generation to execution-unknown exactly once", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, {
      id: 704,
      chatId: "stale-sending",
      html: "<b>May have sent</b>",
      createdAt: now - 1_000,
      expiresAt: now + 600,
      dedupeKey: "stale-sending-key",
      sourceType: "risk_alert",
      alertType: "dews",
      sourceEventId: "stale-sending-source",
      alertScopeJson: serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]),
      preferenceGeneration: 1,
      markupPolicyJson: serializePendingMarkupPolicy({}),
    });
    insertSourceEventSqlite(sqlite, {
      sourceEventId: "stale-sending-source",
      planGeneration: 1,
      detectedAt: now - 3_600,
      expiresAt: now + 3_600,
    });
    sqlite.prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at,
         status, target_count, enqueued_count, metadata
       ) VALUES ('stale-sending-job', 'dews', 'stale-sending-source', 'warning', ?, ?,
                 'queued', 1, 1, '{}')`,
    ).run(now - 3_600, now + 3_600);
    sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, alert_type, pending_dedupe_key, source_event_id,
         plan_generation, status, created_at, effect_state
       ) VALUES ('stale-sending-job', 'stale-sending-target', 'stale-sending-chat', 'dews',
                 'stale-sending-key', 'stale-sending-source', 1, 'queued', ?, 'complete')`,
    ).run(now - 3_600);
    sqlite.prepare(
      `UPDATE telegram_pending_alerts
          SET delivery_state = 'sending', delivery_owner = 'lost-owner',
              delivery_generation = 3, delivery_started_at = ?,
              delivery_claim_expires_at = ?, processing_owner = 'lost-owner',
              processing_expires_at = ?
        WHERE id = 704`,
    ).run(now - PENDING_CLAIM_TTL_SEC - 10, now - 1, now - 1);

    await expect(reconcileStalePendingSending(db, now)).resolves.toBe(1);
    await expect(reconcileStalePendingSending(db, now)).resolves.toBe(0);
    expect(sqlite.prepare(
      `SELECT delivery_state, delivery_owner, delivery_generation,
              processing_owner, last_error_class
         FROM telegram_pending_alerts WHERE id = 704`,
    ).get()).toEqual({
      delivery_state: "execution_unknown",
      delivery_owner: "lost-owner",
      delivery_generation: 3,
      processing_owner: null,
      last_error_class: "pending_effect_owner_lost",
    });

    const replay = await drainPendingQueue(db, "bot-token", 1);
    expect(replay.attempted).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
    expect(sqlite.prepare(
      `SELECT final_delivery_state, final_delivery_error
         FROM telegram_alert_job_targets WHERE job_id = 'stale-sending-job'`,
    ).get()).toEqual({
      final_delivery_state: "execution_unknown",
      final_delivery_error: "pending_effect_owner_lost",
    });
    sqlite.close();
  });

  it("leaves a sending row byte-for-byte unchanged on a dedupe collision", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, {
      id: 705,
      chatId: "sending-collision",
      html: "<b>Original</b>",
      createdAt: now - 4_000,
      expiresAt: now - 1,
      attempts: 7,
      notBeforeAt: now + 300,
      dedupeKey: buildDedupeKey({
        chatId: "sending-collision",
        html: "<b>Original</b>",
        disableNotification: false,
      }),
    });
    sqlite.prepare(
      `UPDATE telegram_pending_alerts
          SET delivery_state = 'sending', delivery_owner = 'active-owner',
              delivery_generation = 4, delivery_started_at = ?,
              delivery_claim_expires_at = ?, processing_owner = 'active-owner',
              processing_started_at = ?, processing_expires_at = ?
        WHERE id = 705`,
    ).run(now - 30, now + 300, now - 30, now + 300);
    const before = sqlite.prepare("SELECT * FROM telegram_pending_alerts WHERE id = 705").get();

    await enqueuePendingAlerts(db, [{
      chatId: "sending-collision",
      html: "<b>Original</b>",
      disableNotification: false,
    }], now, { sourceType: "legacy" });

    expect(sqlite.prepare("SELECT * FROM telegram_pending_alerts WHERE id = 705").get()).toEqual(before);
    sqlite.close();
  });

  it("rejects stale-owner finalization after the sending generation changes", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, {
      id: 706,
      chatId: "owner-loss",
      html: "<b>Owner loss</b>",
      createdAt: now - 30,
      expiresAt: now + 600,
      dedupeKey: "owner-loss-key",
    });
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
    let ownershipChanged = false;
    const ownerLossDb = {
      ...db,
      prepare: (sql: string) => {
        if (
          !ownershipChanged &&
          sql.includes("SET delivery_state = 'sent'") &&
          sql.includes("AND delivery_owner = ?")
        ) {
          ownershipChanged = true;
          sqlite.prepare(
            `UPDATE telegram_pending_alerts
                SET delivery_owner = 'takeover-owner', delivery_generation = delivery_generation + 1
              WHERE id = 706`,
          ).run();
        }
        return db.prepare(sql);
      },
    } as D1Database;

    await expect(drainPendingQueue(ownerLossDb, "bot-token", 1)).rejects.toThrow(
      "sent-state persistence was not confirmed",
    );
    expect(sqlite.prepare(
      "SELECT delivery_state, delivery_owner, delivery_generation FROM telegram_pending_alerts WHERE id = 706",
    ).get()).toEqual({
      delivery_state: "sending",
      delivery_owner: "takeover-owner",
      delivery_generation: 2,
    });
    sqlite.close();
  });

  it.each([
    { errorClass: "rate_limit", statusCode: 429, retryAfterSec: 30 },
    { errorClass: "server_error", statusCode: 503, retryAfterSec: null },
  ] as const)("returns confirmed HTTP $statusCode to pending", async ({ errorClass, statusCode, retryAfterSec }) => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, {
      id: statusCode,
      chatId: `confirmed-${statusCode}`,
      html: "<b>Retry</b>",
      createdAt: now - 30,
      expiresAt: now + 600,
      dedupeKey: `confirmed-${statusCode}-key`,
    });
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode,
      errorClass,
      delivery: "retryable_failure",
      retryAfterSec,
      ...(statusCode === 429 ? { rateLimitScope: "chat" as const } : {}),
    });

    const result = await drainPendingQueue(db, "bot-token", 1);
    expect(result).toMatchObject({ retryQueued: 1, executionUnknown: 0 });
    expect(sqlite.prepare(
      `SELECT delivery_state, delivery_owner, delivery_generation, attempts
         FROM telegram_pending_alerts WHERE id = ?`,
    ).get(statusCode)).toEqual({
      delivery_state: "pending",
      delivery_owner: null,
      delivery_generation: 1,
      attempts: 1,
    });
    sqlite.close();
  });

  it("retains an attempted timeout as execution-unknown without retry", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertSubscriberSqlite(sqlite, {
      chatId: "timeout-ambiguity",
      preferenceGeneration: 1,
      globalAlertDews: 1,
    });
    insertPendingSqlite(sqlite, {
      id: 707,
      chatId: "timeout-ambiguity",
      html: "<b>Timeout</b>",
      createdAt: now - 30,
      expiresAt: now + 600,
      dedupeKey: "timeout-ambiguity-key",
      sourceType: "risk_alert",
      alertType: "dews",
      sourceEventId: "timeout-source",
      alertScopeJson: serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]),
      preferenceGeneration: 1,
      markupPolicyJson: serializePendingMarkupPolicy({}),
    });
    sqlite.prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at,
         status, target_count, enqueued_count, metadata
       ) VALUES ('timeout-job', 'dews', 'timeout-source', 'warning', ?, ?, 'queued', 1, 1, '{}')`,
    ).run(now - 3_600, now + 3_600);
    sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, alert_type, pending_dedupe_key, source_event_id,
         status, created_at, effect_state
       ) VALUES ('timeout-job', 'timeout-target', 'timeout-ambiguity', 'dews',
                 'timeout-ambiguity-key', 'timeout-source', 'queued', ?, 'complete')`,
    ).run(now - 3_600);
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: null,
      errorClass: "timeout",
      delivery: "retryable_failure",
      retryAfterSec: null,
    });

    const first = await drainPendingQueue(db, "bot-token", 1);
    expect(first).toMatchObject({ attempted: 1, retryQueued: 0, executionUnknown: 1 });
    expect(sqlite.prepare(
      `SELECT delivery_state, delivery_generation, attempts, last_error_class
         FROM telegram_pending_alerts WHERE id = 707`,
    ).get()).toEqual({
      delivery_state: "execution_unknown",
      delivery_generation: 1,
      attempts: 0,
      last_error_class: "timeout",
    });
    expect(sqlite.prepare(
      `SELECT status, final_delivery_state, final_delivery_error
         FROM telegram_alert_job_targets WHERE job_id = 'timeout-job'`,
    ).get()).toEqual({
      status: "queued",
      final_delivery_state: "execution_unknown",
      final_delivery_error: "timeout",
    });
    const replay = await drainPendingQueue(db, "bot-token", 1);
    expect(replay.attempted).toBe(0);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    sqlite.close();
  });

  it("does not partially commit pending ambiguity when the target outcome wins the race", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertSubscriberSqlite(sqlite, {
      chatId: "timeout-race",
      preferenceGeneration: 1,
      globalAlertDews: 1,
    });
    insertPendingSqlite(sqlite, {
      id: 708,
      chatId: "timeout-race",
      html: "<b>Timeout race</b>",
      createdAt: now - 30,
      expiresAt: now + 600,
      dedupeKey: "timeout-race-key",
      sourceType: "risk_alert",
      alertType: "dews",
      sourceEventId: "timeout-race-source",
      alertScopeJson: serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]),
      preferenceGeneration: 1,
      markupPolicyJson: serializePendingMarkupPolicy({}),
    });
    sqlite.prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at,
         status, target_count, enqueued_count, metadata
       ) VALUES ('timeout-race-job', 'dews', 'timeout-race-source', 'warning', ?, ?,
                 'queued', 1, 1, '{}')`,
    ).run(now - 3_600, now + 3_600);
    sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, alert_type, pending_dedupe_key, source_event_id,
         status, created_at, effect_state
       ) VALUES ('timeout-race-job', 'timeout-race-target', 'timeout-race', 'dews',
                 'timeout-race-key', 'timeout-race-source', 'queued', ?, 'complete')`,
    ).run(now - 3_600);
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: null,
      errorClass: "network",
      delivery: "retryable_failure",
      retryAfterSec: null,
    });
    let targetWonRace = false;
    const racingDb = {
      ...db,
      prepare: (sql: string) => {
        if (!targetWonRace && sql.includes("SET delivery_state = 'execution_unknown'")) {
          targetWonRace = true;
          sqlite.prepare(
            `UPDATE telegram_alert_job_targets
                SET final_delivery_state = 'accepted', final_delivery_at = ?
              WHERE job_id = 'timeout-race-job'`,
          ).run(now);
        }
        return db.prepare(sql);
      },
    } as D1Database;

    await expect(drainPendingQueue(racingDb, "bot-token", 1)).rejects.toThrow(
      "ambiguity state was not confirmed",
    );
    expect(sqlite.prepare(
      "SELECT delivery_state FROM telegram_pending_alerts WHERE id = 708",
    ).get()).toEqual({ delivery_state: "sending" });
    expect(sqlite.prepare(
      "SELECT final_delivery_state FROM telegram_alert_job_targets WHERE job_id = 'timeout-race-job'",
    ).get()).toEqual({ final_delivery_state: "accepted" });
    sqlite.close();
  });

  it("does not claim legacy pending rows whose target is already terminal", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, {
      id: 703,
      chatId: "terminal-target-chat",
      html: "<b>Already delivered</b>",
      createdAt: now - 30,
      expiresAt: now + 600,
      dedupeKey: "terminal-target-key",
    });
    sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, alert_type, pending_dedupe_key, status, created_at
       ) VALUES ('terminal-job', 'terminal-target', 'terminal-chat', 'dews', ?, 'sent', ?)`,
    ).run("terminal-target-key", now - 30);

    const result = await drainPendingQueue(db, "bot-token", 1);

    expect(result.attempted).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT delivery_state FROM telegram_pending_alerts WHERE id = 703").get())
      .toEqual({ delivery_state: "sent" });
  });

  it("keeps retrying retryable rows past the legacy 5-attempt cap (age-based retry)", async () => {
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

    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 1, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 2 },
          { id: 2, chat_id: "200", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 5 },
          { id: 3, chat_id: "300", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 10 },
        ],
      },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    // All three rows are below PENDING_MAX_ATTEMPTS (20); TTL filter at SELECT time
    // is what bounds retries, not the per-row attempts counter.
    expect(result.retryQueued).toBe(3);
    expect(result.dropped).toBe(0);
    expect(result.droppedMaxAttemptsFallback).toBe(0);
    expect(result.droppedPermanentFailure).toBe(0);
  });

  it("drops retryable rows when the defensive PENDING_MAX_ATTEMPTS ceiling is hit", async () => {
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

    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 1, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: PENDING_MAX_ATTEMPTS - 1 },
          { id: 2, chat_id: "200", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: PENDING_MAX_ATTEMPTS },
          { id: 3, chat_id: "300", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: PENDING_MAX_ATTEMPTS + 5 },
        ],
      },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.retryQueued).toBe(1);
    expect(result.dropped).toBe(2);
    expect(result.droppedMaxAttemptsFallback).toBe(2);
    expect(result.droppedPermanentFailure).toBe(0);
  });

  it("classifies non-retryable Telegram responses as permanent-failure", async () => {
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: false,
      permanentFailure: true,
      statusCode: 400,
      errorClass: "bad_request",
      delivery: "permanent_failure",
      retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 50, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 0 },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.dropped).toBe(1);
    expect(result.droppedPermanentFailure).toBe(1);
    expect(result.droppedMaxAttemptsFallback).toBe(0);
  });

  it("respects the 60→120→240→480→600 backoff schedule when Retry-After is absent", () => {
    expect(PENDING_BACKOFF_SCHEDULE_SEC).toEqual([60, 120, 240, 480, 600]);
    expect(pendingBackoffSec(0, null)).toBe(60);
    expect(pendingBackoffSec(1, null)).toBe(120);
    expect(pendingBackoffSec(2, null)).toBe(240);
    expect(pendingBackoffSec(3, null)).toBe(480);
    expect(pendingBackoffSec(4, null)).toBe(600);
    // Caps at 600 for any higher attempt count.
    expect(pendingBackoffSec(5, null)).toBe(600);
    expect(pendingBackoffSec(19, null)).toBe(600);
  });

  it("prefers Telegram Retry-After over the local backoff schedule", () => {
    expect(pendingBackoffSec(0, 30)).toBe(30);
    expect(pendingBackoffSec(4, 1800)).toBe(1800);
  });

  it("writes scheduled backoff into not_before_at on retry updates", async () => {
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

    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 401, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: now - 60, attempts: 0 },
          { id: 402, chat_id: "200", message_html: "<b>Alert</b>", disable_notification: 0, created_at: now - 60, attempts: 2 },
        ],
      },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
    ]);

    await drainPendingQueue(db, "bot-token", 10);

    const history = db.getHistory();
    const updates = history.filter((e) => e.sql.includes("UPDATE telegram_pending_alerts") && e.sql.includes("SET attempts"));
    expect(updates).toHaveLength(2);
    // attempts=0 → backoff 60s; attempts=2 → backoff 240s.
    const notBeforeForRow401 = updates.find((u) => u.binds[4] === 401)?.binds[0];
    const notBeforeForRow402 = updates.find((u) => u.binds[4] === 402)?.binds[0];
    expect(notBeforeForRow401).toBe(now + 60);
    expect(notBeforeForRow402).toBe(now + 240);
  });

  it("sustains delivery across a 30 minute 429 storm by re-driving the queue", async () => {
    // Simulate the operational scenario from the plan: a single row hammered by 429s
    // for 30 minutes should eventually deliver (not expire). Each subsequent drain
    // succeeds once the wall clock advances past not_before_at; the row's attempts
    // counter rises but never trips the legacy 5-attempt cap.
    const rateLimited = {
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 429,
      errorClass: "rate_limit",
      delivery: "retryable_failure",
      retryAfterSec: 120,
    };
    const sent = {
      ok: true,
      blocked: false,
      retryable: false,
      permanentFailure: false,
      statusCode: 200,
      errorClass: null,
      delivery: "sent",
      retryAfterSec: null,
    };

    const created = Math.floor(Date.now() / 1000);
    let attempts = 0;
    let delivered = false;

    // Drain loop: each iteration advances by 5 minutes (well over the 120s Retry-After)
    // and reuses the same row id. The row stays inside PENDING_TTL_SEC for the full
    // 30 minutes (1800s < 3600s).
    for (let elapsedMin = 0; elapsedMin <= 30 && !delivered; elapsedMin += 5) {
      vi.setSystemTime(new Date(Date.now() + (elapsedMin === 0 ? 0 : 5 * 60_000)));
      // 5 of 7 iterations are 429; on the 6th iteration we let it succeed.
      mockSendToChat.mockResolvedValueOnce(elapsedMin >= 25 ? sent : rateLimited);

      const db = mockD1([
        {
          match: "FROM telegram_pending_alerts p",
          rows: [
            { id: 999, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: created, attempts },
          ],
        },
        { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
        { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
      ]);

      const result = await drainPendingQueue(db, "bot-token", 10);
      if (result.sent === 1) {
        delivered = true;
      } else {
        expect(result.retryQueued).toBe(1);
        expect(result.dropped).toBe(0);
        attempts += 1;
        // Each iteration the row stays under the defensive ceiling.
        expect(attempts).toBeLessThan(PENDING_MAX_ATTEMPTS);
      }
    }

    expect(delivered).toBe(true);
  });

  it("deletes successfully sent messages from the queue", async () => {
    mockSendToChat.mockResolvedValue({
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 10, chat_id: "100", message_html: "<b>Sent</b>", disable_notification: 0, created_at: 1000, attempts: 0 },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.sent).toBe(1);
    expect(result.attempted).toBe(1);

    const history = db.getHistory();
    const deleteCall = history.find((e) => e.sql.includes("DELETE FROM telegram_pending_alerts WHERE id IN"));
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.binds).toContain(10);
  });

  it("claims pending rows for two dispatch intervals", async () => {
    mockSendToChat.mockResolvedValue({
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    });

    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 11, chat_id: "100", message_html: "<b>Sent</b>", disable_notification: 0, created_at: now - 30, attempts: 0 },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    await drainPendingQueue(db, "bot-token", 10);

    const claimUpdate = db.getHistory().find((entry) =>
      entry.sql.includes("UPDATE telegram_pending_alerts") &&
      entry.sql.includes("SET processing_owner = ?")
    );
    expect(claimUpdate?.binds[1]).toBe(now);
    expect(claimUpdate?.binds[2]).toBe(now + 10 * 60);
  });

  it("chunks 101 successful pending deletes below the D1 bind limit", async () => {
    mockSendToChat.mockResolvedValue({
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    });

    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      chat_id: `chat-${index}`,
      message_html: `<b>Sent ${index}</b>`,
      disable_notification: 0,
      created_at: 1000,
      attempts: 0,
      dedupe_key: `key-${index}`,
      chunk_index: 0,
      last_error_class: null,
    }));
    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 101);

    expect(result.sent).toBe(101);
    const deletes = db.getHistory().filter((entry) =>
      entry.sql.includes("DELETE FROM telegram_pending_alerts WHERE id IN")
    );
    expect(deletes).toHaveLength(2);
    expect(deletes.every((entry) => entry.binds.length <= 90)).toBe(true);
    expect(deletes.map((entry) => entry.binds.length)).toEqual([90, 11]);
  });

  it("honors a drain budget that is exhausted before a full send batch", async () => {
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

    const { sqlite, db } = setupTelegramPendingSqlite();
    try {
      const now = Math.floor(Date.now() / 1000);
      const drainLimit = 2;
      expect(drainLimit).toBeLessThan(SEND_BATCH_SIZE);

      insertPendingSqlite(sqlite, { id: 901, chatId: "budget-1", html: "<b>One</b>", createdAt: now - 30 });
      insertPendingSqlite(sqlite, { id: 902, chatId: "budget-2", html: "<b>Two</b>", createdAt: now - 20 });
      insertPendingSqlite(sqlite, { id: 903, chatId: "budget-3", html: "<b>Three</b>", createdAt: now - 10 });

      const result = await drainPendingQueue(db, "bot-token", drainLimit);

      expect(result.attempted).toBe(2);
      expect(result.sent).toBe(2);
      expect(mockSendToChat).toHaveBeenCalledTimes(2);
      expect(mockSendToChat.mock.calls.map(([chatId]) => chatId)).toEqual(["budget-1", "budget-2"]);

      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 1 });
      expect(
        sqlite.prepare("SELECT chat_id, processing_owner FROM telegram_pending_alerts").get(),
      ).toEqual({ chat_id: "budget-3", processing_owner: null });
    } finally {
      sqlite.close();
    }
  });

  it("records a first-strike chat_not_found without zeroing alert flags and deletes the pending message", async () => {
    mockSendToChat.mockResolvedValue({
      ok: false, blocked: true, retryable: false, permanentFailure: true,
      statusCode: 400, errorClass: "chat_not_found", delivery: "blocked", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 20, chat_id: "blocked-chat", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 0 },
        ],
      },
      // Two-strike SELECT: no prior strike on file.
      { match: "SELECT consecutive_block_count", rows: [] },
      // Counter UPDATE writes count=1, first_at=now.
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.blocked).toBe(1);
    expect(result.blockedCleanedUp).toBe(0);
    expect(result.sent).toBe(0);

    const history = db.getHistory();
    // First strike must increment the counter, not zero out alert flags.
    const counterUpdate = history.find(
      (entry) =>
        entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("consecutive_block_count"),
    );
    expect(counterUpdate).toBeDefined();
    expect(counterUpdate!.binds[0]).toBe(1);
    // No aggressive cascade on first strike.
    const flagCascade = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("alert_dews=0"),
    );
    expect(flagCascade).toBeUndefined();
  });

  it("disables the subscriber on a second chat_not_found within the 24h window", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue({
      ok: false, blocked: true, retryable: false, permanentFailure: true,
      statusCode: 400, errorClass: "chat_not_found", delivery: "blocked", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 21, chat_id: "double-strike", message_html: "<b>Alert</b>", disable_notification: 0, created_at: now - 60, attempts: 0 },
        ],
      },
      // Prior strike recorded ~1h ago, still within 24h window.
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 3600 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.blocked).toBe(1);
    expect(result.blockedCleanedUp).toBe(1);

    const history = db.getHistory();
    // Counter update goes first, then the aggressive cascade flips all alert flags.
    const counterUpdate = history.find(
      (entry) =>
        entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("consecutive_block_count = ?"),
    );
    expect(counterUpdate).toBeDefined();
    expect(counterUpdate!.binds[0]).toBe(2);

    const flagCascade = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("alert_launch=0"),
    );
    expect(flagCascade).toBeDefined();
    expect(flagCascade!.sql).toContain("global_alert_launch=0");
    expect(flagCascade!.sql).toContain("alert_reserve=0");
    expect(flagCascade!.sql).toContain("global_alert_reserve=0");
    const subscriptionsCascade = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscriptions") && entry.sql.includes("alert_launch=0"),
    );
    expect(subscriptionsCascade).toBeDefined();
    expect(subscriptionsCascade!.sql).toContain("alert_reserve=0");
  });

  it("dead-letters and deletes sibling pending rows when a second chat_not_found disables the chat", async () => {
    const { sqlite, db } = setupTelegramPendingSqlite();
    try {
      const now = Math.floor(Date.now() / 1000);
      sqlite
        .prepare(
          `INSERT INTO telegram_subscribers (
             chat_id, created_at, last_active_at, consecutive_block_count, consecutive_block_first_at,
             alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
             global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch, global_alert_reserve
           )
           VALUES (?, ?, ?, 1, ?, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)`,
        )
        .run("double-strike-siblings", now - 600, now - 600, now - 60);
      insertPendingSqlite(sqlite, {
        id: 210,
        chatId: "double-strike-siblings",
        html: "<b>Attempted</b>",
        createdAt: now - 120,
        dedupeKey: "double-strike-siblings:attempted",
      });
      insertPendingSqlite(sqlite, {
        id: 211,
        chatId: "double-strike-siblings",
        html: "<b>Sibling</b>",
        createdAt: now - 60,
        notBeforeAt: now + 600,
        dedupeKey: "double-strike-siblings:sibling",
      });

      mockSendToChat.mockResolvedValue({
        ok: false, blocked: true, retryable: false, permanentFailure: true,
        statusCode: 400, errorClass: "chat_not_found", delivery: "blocked", retryAfterSec: null,
      });

      const result = await drainPendingQueue(db, "bot-token", 1);

      expect(result.blocked).toBe(1);
      expect(result.blockedCleanedUp).toBe(1);
      expect(result.blockedCleanupFailed).toBe(0);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
      const deadLetters = sqlite
        .prepare("SELECT pending_id, reason FROM telegram_alert_dead_letters ORDER BY pending_id ASC")
        .all();
      expect(deadLetters).toEqual([
        { pending_id: 210, reason: "blocked_disabled" },
        { pending_id: 211, reason: "blocked_disabled" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("counts a blocked chat once while preserving per-row pending diagnostics", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue({
      ok: false, blocked: true, retryable: false, permanentFailure: true,
      statusCode: 403, errorClass: "blocked", delivery: "blocked", retryAfterSec: null,
    });

    const blockedRows = Array.from({ length: SEND_BATCH_SIZE + 1 }, (_, index) => ({
      id: 1200 + index,
      chat_id: "same-blocked-chat",
      message_html: `<b>Blocked ${index}</b>`,
      disable_notification: 0,
      created_at: now - 60,
      attempts: 0,
      not_before_at: null,
      priority: TELEGRAM_PENDING_PRIORITY.depeg,
      source_type: "risk_alert",
      alert_type: "depeg",
      dedupe_key: `same-blocked-chat:${index}`,
      chunk_index: index,
      last_error_class: null,
      alert_snooze_until_ts: null,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      timezone: null,
    }));
    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows: blockedRows },
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 300 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
      { match: "INSERT INTO telegram_chat_delivery_diagnostics", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", blockedRows.length);

    expect(result.attempted).toBe(1);
    expect(result.blocked).toBe(blockedRows.length);
    expect(result.blockedCleanedUp).toBe(1);
    expect(result.blockedCleanupFailed).toBe(0);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);

    const history = db.getHistory();
    expect(history.filter((entry) => entry.sql.includes("SELECT consecutive_block_count"))).toHaveLength(1);
    expect(
      history.filter(
        (entry) =>
          entry.sql.includes("UPDATE telegram_subscribers") &&
          entry.sql.includes("consecutive_block_count = ?"),
      ),
    ).toHaveLength(1);
    expect(
      history.filter(
        (entry) =>
          entry.sql.includes("UPDATE telegram_subscribers") &&
          entry.sql.includes("alert_launch=0") &&
          entry.sql.includes("alert_reserve=0") &&
          entry.sql.includes("global_alert_reserve=0"),
      ),
    ).toHaveLength(1);
    expect(
      history.filter((entry) =>
        entry.sql.includes("UPDATE telegram_subscriptions") &&
        entry.sql.includes("alert_launch=0") &&
        entry.sql.includes("alert_reserve=0"),
      ),
    ).toHaveLength(1);
    expect(history.filter((entry) => entry.sql.includes("DELETE FROM telegram_preset_subscriptions"))).toHaveLength(1);
    expect(history.filter((entry) => entry.sql.includes("INSERT INTO telegram_chat_delivery_diagnostics"))).toHaveLength(1);
    expect(history.filter((entry) => entry.sql.includes("UPDATE telegram_alert_job_targets"))).toHaveLength(blockedRows.length);
    const deadLetters = history.filter((entry) => entry.sql.includes("INSERT INTO telegram_alert_dead_letters"));
    expect(deadLetters).toHaveLength(blockedRows.length);
    expect(deadLetters.map((entry) => entry.binds[11])).toEqual(blockedRows.map(() => "blocked_disabled"));
  });

  it("dead-letters an unattempted same-chat tail after a permanent predecessor failure", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: false,
      permanentFailure: true,
      statusCode: 400,
      errorClass: "bad_request",
      delivery: "permanent_failure",
      retryAfterSec: null,
    });
    const rows = Array.from({ length: 4 }, (_, index) => ({
      id: 1300 + index,
      chat_id: "same-permanent-chat",
      message_html: `chunk-${index}`,
      disable_notification: 0,
      created_at: now - 60,
      attempts: 0,
      chunk_index: index,
      dedupe_key: `same-permanent-chat:${index}`,
    }));
    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", rows.length);

    expect(result).toMatchObject({
      attempted: 1,
      dropped: rows.length,
      droppedPermanentFailure: rows.length,
    });
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(
      db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO telegram_alert_dead_letters")),
    ).toHaveLength(rows.length);
  });

  it("migrates a group after terminally archiving Telegram's old-chat response", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: false,
      permanentFailure: true,
      statusCode: 400,
      errorClass: "chat_migrated",
      delivery: "permanent_failure",
      retryAfterSec: null,
      migrateToChatId: "-1001234567890",
    });
    const row = {
      id: 1310,
      chat_id: "-1234567890",
      message_html: "migrated group alert",
      disable_notification: 0,
      created_at: now - 60,
      attempts: 0,
      chunk_index: 0,
      dedupe_key: "-1234567890:v1:0:test",
    };
    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows: [row] },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts", rows: [] },
    ]);

    await expect(drainPendingQueue(db, "bot-token", 1)).resolves.toMatchObject({
      attempted: 1,
      droppedPermanentFailure: 1,
    });
    expect(mockMigrateTelegramChatId).toHaveBeenCalledOnce();
    expect(mockMigrateTelegramChatId).toHaveBeenCalledWith(db, "-1234567890", "-1001234567890");
  });

  it("treats a stale first strike (older than 24h) as a fresh first strike", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue({
      ok: false, blocked: true, retryable: false, permanentFailure: true,
      statusCode: 403, errorClass: "blocked", delivery: "blocked", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 22, chat_id: "stale-strike", message_html: "<b>Alert</b>", disable_notification: 0, created_at: now - 60, attempts: 0 },
        ],
      },
      // Prior strike recorded >24h ago: window expired, treat as fresh.
      {
        match: "SELECT consecutive_block_count",
        rows: [
          {
            consecutive_block_count: 1,
            consecutive_block_first_at: now - (BLOCK_STRIKE_WINDOW_SEC + 60),
          },
        ],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    await drainPendingQueue(db, "bot-token", 10);

    const history = db.getHistory();
    const counterUpdate = history.find(
      (entry) =>
        entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("consecutive_block_count = ?"),
    );
    expect(counterUpdate).toBeDefined();
    // Stale strike re-stamps count=1 and first_at=now (not count=2).
    expect(counterUpdate!.binds[0]).toBe(1);
    expect(counterUpdate!.binds[1]).toBe(now);

    // No flag cascade because we are back at first strike.
    const flagCascade = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("alert_launch=0"),
    );
    expect(flagCascade).toBeUndefined();
  });

  it("resets the consecutive_block_count on a successful send", async () => {
    mockSendToChat.mockResolvedValue({
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 23, chat_id: "recovered", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 0 },
        ],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.sent).toBe(1);

    const history = db.getHistory();
    const resetCall = history.find(
      (entry) =>
        entry.sql.includes("UPDATE telegram_subscribers") &&
        entry.sql.includes("consecutive_block_count = 0") &&
        entry.sql.includes("consecutive_block_first_at = NULL"),
    );
    expect(resetCall).toBeDefined();
    expect(resetCall!.binds).toEqual(["recovered"]);
  });

  it("stops draining the queue when a global 429 rate limit is received", async () => {
    // SEND_BATCH_SIZE=4, so we need >4 messages to span multiple batches.
    // First batch (4 msgs): 3 ok + 1 rate_limit. Sets rateLimited=true.
    // Second batch (3 msgs): never attempted because rateLimited flag breaks the loop.
    const okResult = {
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    };
    const rateLimitResult = {
      ok: false, blocked: false, retryable: true, permanentFailure: false,
      statusCode: 429, errorClass: "rate_limit", delivery: "retryable_failure", retryAfterSec: 30, rateLimitScope: "global" as const,
    };

    // First 3 calls succeed, 4th returns 429 (within first batch of 4)
    mockSendToChat
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(rateLimitResult);

    // 8 pending messages -> batch 1 (ids 1-4), batch 2 (ids 5-8)
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, chat_id: `chat-${i}`, message_html: `msg${i}`, disable_notification: 0, created_at: 1000, attempts: 0,
    }));

    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 20);

    // Only first batch of 4 was attempted; second batch of 4 was skipped
    expect(result.attempted).toBe(4);
    expect(result.sent).toBe(3);
    expect(result.retryQueued).toBe(1);
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterSec).toBe(30);
    expect(mockSendToChat).toHaveBeenCalledTimes(4);
  });

  it("continues draining other pending chats after a chat-scoped 429", async () => {
    const okResult = {
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    };
    const rateLimitResult = {
      ok: false, blocked: false, retryable: true, permanentFailure: false,
      statusCode: 429, errorClass: "rate_limit", delivery: "retryable_failure", retryAfterSec: 30, rateLimitScope: "chat" as const,
    };

    mockSendToChat
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(rateLimitResult)
      .mockResolvedValue(okResult);

    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, chat_id: `chat-${i}`, message_html: `msg${i}`, disable_notification: 0, created_at: 1000, attempts: 0,
    }));

    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 20);

    expect(result.attempted).toBe(8);
    expect(result.sent).toBe(7);
    expect(result.retryQueued).toBe(1);
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterSec).toBe(30);
    expect(mockSendToChat).toHaveBeenCalledTimes(8);
  });

  it("defers all later same-chat chunks when the first pending chunk is rate-limited", async () => {
    const okResult = {
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    };
    const rateLimitResult = {
      ok: false, blocked: false, retryable: true, permanentFailure: false,
      statusCode: 429, errorClass: "rate_limit", delivery: "retryable_failure", retryAfterSec: 45, rateLimitScope: "chat" as const,
    };

    mockSendToChat
      .mockResolvedValueOnce(rateLimitResult)
      .mockResolvedValue(okResult);

    const rows = [
      { id: 1, chat_id: "chat-a", message_html: "chunk-0", disable_notification: 0, created_at: 1000, attempts: 0, chunk_index: 0 },
      { id: 2, chat_id: "chat-a", message_html: "chunk-1", disable_notification: 0, created_at: 1000, attempts: 0, chunk_index: 1 },
      { id: 3, chat_id: "chat-a", message_html: "chunk-2", disable_notification: 0, created_at: 1000, attempts: 0, chunk_index: 2 },
      { id: 4, chat_id: "chat-a", message_html: "chunk-3", disable_notification: 0, created_at: 1000, attempts: 0, chunk_index: 3 },
      { id: 5, chat_id: "chat-b", message_html: "other", disable_notification: 0, created_at: 1000, attempts: 0, chunk_index: 0 },
    ];

    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 20);

    expect(result.attempted).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.retryQueued).toBe(1);
    expect(result.deferred).toBe(3);
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterSec).toBe(45);
    expect(mockSendToChat).toHaveBeenCalledTimes(2);

    const now = Math.floor(Date.now() / 1000);
    const retryUpdates = db.getHistory().filter((entry) =>
      entry.sql.includes("UPDATE telegram_pending_alerts") &&
      entry.sql.includes("SET attempts = attempts + 1")
    );
    expect(retryUpdates.map((entry) => entry.binds[4])).toEqual([1]);
    expect(retryUpdates[0]?.binds[0]).toBe(now + 45);

    const deferUpdates = db.getHistory().filter((entry) =>
      entry.sql.includes("UPDATE telegram_pending_alerts") &&
      entry.sql.includes("SET not_before_at = ?")
    );
    expect(deferUpdates.map((entry) => entry.binds.slice(0, 4))).toEqual([
      [now + 45, null, now, 2],
      [now + 45, null, now, 3],
      [now + 45, null, now, 4],
    ]);
  });

  it("keeps repeated chat-scoped 429s local to their rows", async () => {
    const okResult = {
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    };
    const rateLimitResult = {
      ok: false, blocked: false, retryable: true, permanentFailure: false,
      statusCode: 429, errorClass: "rate_limit", delivery: "retryable_failure", retryAfterSec: 10, rateLimitScope: "chat" as const,
    };

    mockSendToChat
      .mockResolvedValueOnce(rateLimitResult)
      .mockResolvedValueOnce(rateLimitResult)
      .mockResolvedValueOnce(rateLimitResult)
      .mockResolvedValue(okResult);

    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1, chat_id: `chat-${i}`, message_html: `msg${i}`, disable_notification: 0, created_at: 1000, attempts: 0,
    }));

    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
      { match: "UPDATE telegram_pending_alerts\n            SET processing_owner = NULL", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 20);

    expect(result.attempted).toBe(5);
    expect(result.sent).toBe(2);
    expect(result.retryQueued).toBe(3);
    expect(result.rateLimited).toBe(true);
    expect(mockSendToChat).toHaveBeenCalledTimes(5);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(false);
  });

  it("stamps row-level backoff without setting global backoff on a chat-scoped 429", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 429,
      errorClass: "rate_limit",
      delivery: "retryable_failure",
      retryAfterSec: 45,
      rateLimitScope: "chat" as const,
    });

    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 610, chat_id: "chat-scoped", message_html: "<b>Limited</b>", disable_notification: 0, created_at: now - 30, attempts: 0 },
        ],
      },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterSec).toBe(45);
    expect(result.notBeforeAt).toBe(now + 45);

    const history = db.getHistory();
    const retryUpdate = history.find((entry) =>
      entry.sql.includes("UPDATE telegram_pending_alerts") &&
      entry.sql.includes("SET attempts = attempts + 1")
    );
    expect(retryUpdate?.binds.slice(0, 5)).toEqual([now + 45, "rate_limit", 45, now, 610]);
    expect(history.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(false);
  });

  it("sets global backoff and leaves row not_before_at clear on a global 429", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 429,
      errorClass: "rate_limit",
      delivery: "retryable_failure",
      retryAfterSec: 45,
      rateLimitScope: "global" as const,
    });

    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          { id: 611, chat_id: "global-scoped", message_html: "<b>Limited</b>", disable_notification: 0, created_at: now - 30, attempts: 0 },
        ],
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterSec).toBe(45);
    expect(result.notBeforeAt).toBe(now + 45);

    const history = db.getHistory();
    const cacheWrite = history.find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    expect(cacheWrite?.binds).toEqual([
      TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY,
      String(now + 45),
      now,
    ]);

    const retryUpdate = history.find((entry) =>
      entry.sql.includes("UPDATE telegram_pending_alerts") &&
      entry.sql.includes("SET attempts = attempts + 1")
    );
    expect(retryUpdate?.binds.slice(0, 5)).toEqual([null, "rate_limit", 45, now, 611]);
  });

  it("does not select expired or not-yet-ready pending rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows: [] },
    ]);

    await drainPendingQueue(db, "bot-token", 10);

    expect(mockSendToChat).not.toHaveBeenCalled();
    const selectCall = db.getHistory().find((entry) => entry.sql.includes("FROM telegram_pending_alerts p\n"));
    expect(selectCall?.sql).toContain("COALESCE(p.expires_at, p.created_at + ?) > ?");
    expect(selectCall?.sql).toContain("p.not_before_at IS NULL OR p.not_before_at <= ?");
    expect(selectCall?.binds).toEqual([
      PENDING_TTL_SEC,
      now,
      now,
      null,
      TELEGRAM_PENDING_PRIORITY.legacy,
      null,
      now,
      TELEGRAM_PENDING_PRIORITY.legacy,
      10,
    ]);
  });

  it("can restrict drain selection to risk-priority rows during fresh alert contention", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows: [] },
    ]);

    await drainPendingQueue(db, "bot-token", 10, undefined, {
      maxPriority: TELEGRAM_PENDING_PRIORITY.riskAlert,
    });

    const selectCall = db.getHistory().find((entry) => entry.sql.includes("FROM telegram_pending_alerts p\n"));
    expect(selectCall?.sql).toContain("COALESCE(p.priority");
    expect(selectCall?.binds).toEqual([
      PENDING_TTL_SEC,
      now,
      now,
      TELEGRAM_PENDING_PRIORITY.riskAlert,
      TELEGRAM_PENDING_PRIORITY.legacy,
      TELEGRAM_PENDING_PRIORITY.riskAlert,
      now,
      TELEGRAM_PENDING_PRIORITY.legacy,
      10,
    ]);
  });

  it("defers currently snoozed pending rows without sending", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          {
            id: 30,
            chat_id: "snoozed",
            message_html: "<b>Alert</b>",
            disable_notification: 0,
            created_at: now - 60,
            attempts: 0,
            not_before_at: null,
            alert_snooze_until_ts: now + 900,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      { match: "UPDATE telegram_pending_alerts SET not_before_at", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.deferred).toBe(1);
    expect(result.attempted).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("SET not_before_at"));
    expect(updateCall?.binds.slice(0, 4)).toEqual([now + 900, "preference_snoozed", now, 30]);
  });

  it("sends pending rows during current quiet hours with notifications silenced", async () => {
    mockSendToChat.mockResolvedValue({
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    });
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          {
            id: 31,
            chat_id: "quiet",
            message_html: "<b>Alert</b>",
            disable_notification: 0,
            created_at: now - 60,
            attempts: 0,
            not_before_at: null,
            alert_snooze_until_ts: null,
            quiet_hours_enabled: 1,
            quiet_hours_start_utc: 0,
            quiet_hours_end_utc: 23,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.deferred).toBe(0);
    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledWith(
      "quiet",
      "<b>Alert</b>",
      "bot-token",
      expect.objectContaining({ disableNotification: true }),
    );
  });

  it("orders pending chunks by chunk_index when priority, created_at, and not_before_at tie", async () => {
    // P1.9 regression: when chunk 0 of a multi-chunk message is already claimed
    // (or just retrying separately) and chunks 1-2 enter the queue with the same
    // priority/created_at/not_before_at, the next drain must surface them in
    // chunk_index order — no interleaving. Mock D1 does not sort; the test
    // verifies the SQL ORDER BY ends with `p.chunk_index ASC` in both the
    // candidate SELECT and the claimed-row SELECT.
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

    const now = Math.floor(Date.now() / 1000);
    // Seed the SELECT in ORDER BY order. Chunk 0 is intentionally absent (e.g.
    // already claimed by another owner).
    const orderedChunks = [
      {
        id: 801,
        chat_id: "multi-chunk-chat",
        message_html: "<b>Chunk 1</b>",
        disable_notification: 0,
        created_at: now - 10,
        attempts: 0,
        not_before_at: null,
        alert_snooze_until_ts: null,
        quiet_hours_enabled: 0,
        quiet_hours_start_utc: null,
        quiet_hours_end_utc: null,
        chunk_index: 1,
        dedupe_key: "multi:chunk:1",
      },
      {
        id: 802,
        chat_id: "multi-chunk-chat",
        message_html: "<b>Chunk 2</b>",
        disable_notification: 0,
        created_at: now - 10,
        attempts: 0,
        not_before_at: null,
        alert_snooze_until_ts: null,
        quiet_hours_enabled: 0,
        quiet_hours_start_utc: null,
        quiet_hours_end_utc: null,
        chunk_index: 2,
        dedupe_key: "multi:chunk:2",
      },
    ];
    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows: orderedChunks },
      { match: "UPDATE telegram_pending_alerts", rows: [] },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.sent).toBe(2);
    expect(result.acceptedChats).toBe(1);

    // Both SELECTs (candidate-id scan and claimed-row load) must include
    // chunk_index ASC as the final tiebreaker so chunks of the same message
    // never interleave across drain runs.
    const selects = db
      .getHistory()
      .filter((entry) => entry.sql.includes("FROM telegram_pending_alerts p\n"));
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const entry of selects) {
      expect(entry.sql).toMatch(/ORDER BY[\s\S]+p\.chunk_index ASC\s+LIMIT/);
    }

    // Order returned by drain reflects the SQL ORDER BY: chunk 1 before chunk 2.
    const callOrder = mockSendToChat.mock.calls.map((call) => call[1] as string);
    expect(callOrder).toEqual(["<b>Chunk 1</b>", "<b>Chunk 2</b>"]);
  });

  it("drains four same-chat chunks serially while distinct chats use four send slots", async () => {
    vi.useRealTimers();
    const now = Math.floor(Date.now() / 1000);
    const started: string[] = [];
    const completed: string[] = [];
    const releases = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;
    let sameChatActive = 0;
    let maxSameChatActive = 0;
    const okResult = {
      ok: true,
      blocked: false,
      retryable: false,
      permanentFailure: false,
      statusCode: 200,
      errorClass: null,
      delivery: "sent",
      retryAfterSec: null,
    };

    mockSendToChat.mockImplementation((chatId: string, html: string) => {
      const key = `${chatId}:${html}`;
      started.push(key);
      active++;
      maxActive = Math.max(maxActive, active);
      if (chatId === "same-chat") {
        sameChatActive++;
        maxSameChatActive = Math.max(maxSameChatActive, sameChatActive);
      }
      return new Promise((resolve) => {
        releases.set(key, () => {
          completed.push(key);
          active--;
          if (chatId === "same-chat") sameChatActive--;
          resolve(okResult);
        });
      });
    });

    const rows = [
      ...Array.from({ length: 4 }, (_, index) => ({
        id: 1800 + index,
        chat_id: "same-chat",
        message_html: `chunk-${index}`,
        disable_notification: 0,
        created_at: now - 60,
        attempts: 0,
        chunk_index: index,
      })),
      ...["other-a", "other-b", "other-c"].map((chatId, index) => ({
        id: 1900 + index,
        chat_id: chatId,
        message_html: "only-chunk",
        disable_notification: 0,
        created_at: now - 60,
        attempts: 0,
        chunk_index: 0,
      })),
    ];
    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const drainPromise = drainPendingQueue(db, "bot-token", rows.length);
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started).toEqual([
      "same-chat:chunk-0",
      "other-a:only-chunk",
      "other-b:only-chunk",
      "other-c:only-chunk",
    ]);

    releases.get("other-a:only-chunk")?.();
    releases.get("other-b:only-chunk")?.();
    releases.get("other-c:only-chunk")?.();
    await Promise.resolve();
    expect(started).toHaveLength(4);
    releases.get("same-chat:chunk-0")?.();

    for (let index = 1; index < 4; index++) {
      const key = `same-chat:chunk-${index}`;
      await vi.waitFor(() => expect(started).toContain(key));
      releases.get(key)?.();
    }

    const result = await drainPromise;
    expect(result).toMatchObject({ attempted: rows.length, sent: rows.length });
    expect(started.filter((key) => key.startsWith("same-chat:"))).toEqual([
      "same-chat:chunk-0",
      "same-chat:chunk-1",
      "same-chat:chunk-2",
      "same-chat:chunk-3",
    ]);
    expect(completed.filter((key) => key.startsWith("same-chat:"))).toEqual([
      "same-chat:chunk-0",
      "same-chat:chunk-1",
      "same-chat:chunk-2",
      "same-chat:chunk-3",
    ]);
    expect(maxActive).toBe(SEND_BATCH_SIZE);
    expect(maxSameChatActive).toBe(1);
  });

  it("returns zeros when queue is empty", async () => {
    const db = mockD1([
      { match: "FROM telegram_pending_alerts p", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result).toEqual({
      attempted: 0,
      sent: 0,
      acceptedChats: 0,
      blocked: 0,
      blockedCleanedUp: 0,
      blockedCleanupFailed: 0,
      retryQueued: 0,
      executionUnknown: 0,
      dropped: 0,
      droppedPermanentFailure: 0,
      droppedMaxAttemptsFallback: 0,
      deferred: 0,
      rateLimited: false,
      retryAfterSec: null,
      notBeforeAt: null,
    });
  });

  it("handles a 500-row mixed-state pending queue and starves no eligible chat across 3 ticks", async () => {
    // P1-T1: at-scale verification of the pending queue with mixed row states.
    // Seeds 500 alerts spread across five categories (100 each) and walks the
    // drain dispatcher through three simulated ticks, asserting prioritization,
    // snooze deferral, quiet-hours silencing, expiration cleanup, and fairness.
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

    const now = Math.floor(Date.now() / 1000);
    const futureNotBefore = now + 300; // 5 min in the future
    const futureSnooze = now + 900;    // 15 min in the future
    const expiredCreatedAt = now - (PENDING_TTL_SEC + 60);

    // Helper: seed a balanced mix of 500 rows. Returns the full row set plus
    // the subset that would actually pass the production SELECT's WHERE clause
    // (created_at >= cutoff AND (not_before_at IS NULL OR <= now)).
    const seed = () => {
      const rows: Array<{
        id: number; chat_id: string; message_html: string; disable_notification: number;
        created_at: number; attempts: number; not_before_at: number | null;
        alert_snooze_until_ts: number | null; quiet_hours_enabled: number;
        quiet_hours_start_utc: number | null; quiet_hours_end_utc: number | null;
      }> = [];
      // 100 immediately deliverable rows (oldest first via created_at).
      for (let i = 0; i < 100; i++) {
        rows.push({
          id: 1000 + i,
          chat_id: `deliver-${i}`,
          message_html: `<b>D${i}</b>`,
          disable_notification: 0,
          created_at: now - 600 - i, // older = higher priority
          attempts: 0,
          not_before_at: null,
          alert_snooze_until_ts: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        });
      }
      // 100 rows in per-chat backoff (not_before_at in the future).
      for (let i = 0; i < 100; i++) {
        rows.push({
          id: 2000 + i,
          chat_id: `backoff-${i}`,
          message_html: `<b>B${i}</b>`,
          disable_notification: 0,
          created_at: now - 400,
          attempts: 1,
          not_before_at: futureNotBefore,
          alert_snooze_until_ts: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        });
      }
      // 100 rows owned by snoozed chats (subscriber alert_snooze_until_ts in future).
      for (let i = 0; i < 100; i++) {
        rows.push({
          id: 3000 + i,
          chat_id: `snoozed-${i}`,
          message_html: `<b>S${i}</b>`,
          disable_notification: 0,
          created_at: now - 500 - i,
          attempts: 0,
          not_before_at: null,
          alert_snooze_until_ts: futureSnooze,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        });
      }
      // 100 rows owned by chats in active quiet hours. With vi system time
      // 2026-04-23T12:00:00Z, hour 12 UTC ∈ [0, 23) → quiet hours active.
      for (let i = 0; i < 100; i++) {
        rows.push({
          id: 4000 + i,
          chat_id: `quiet-${i}`,
          message_html: `<b>Q${i}</b>`,
          disable_notification: 0,
          created_at: now - 300 - i,
          attempts: 0,
          not_before_at: null,
          alert_snooze_until_ts: null,
          quiet_hours_enabled: 1,
          quiet_hours_start_utc: 0,
          quiet_hours_end_utc: 23,
        });
      }
      // 100 expired rows (created_at older than PENDING_TTL_SEC). These would
      // be filtered out by the SELECT in production; we still seed them so the
      // cleanup assertion exercises the same row set.
      for (let i = 0; i < 100; i++) {
        rows.push({
          id: 5000 + i,
          chat_id: `expired-${i}`,
          message_html: `<b>E${i}</b>`,
          disable_notification: 0,
          created_at: expiredCreatedAt,
          attempts: 0,
          not_before_at: null,
          alert_snooze_until_ts: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        });
      }
      // SELECT-pass subset matches the production SQL filters and the ORDER BY
      // (COALESCE(not_before_at, created_at) ASC, created_at ASC).
      const selectable = rows
        .filter((r) => r.created_at >= now - PENDING_TTL_SEC)
        .filter((r) => r.not_before_at == null || r.not_before_at <= now)
        .sort((a, b) => {
          const aKey = a.not_before_at ?? a.created_at;
          const bKey = b.not_before_at ?? b.created_at;
          return aKey - bKey || a.created_at - b.created_at;
        });
      return { rows, selectable };
    };

    const { rows: allRows, selectable } = seed();
    // Sanity: 500 seeded; 300 selectable (deliver + snoozed + quiet); 200 filtered
    // (100 expired by TTL + 100 by future not_before_at).
    expect(allRows).toHaveLength(500);
    expect(selectable).toHaveLength(300);

    // Tick 1: drain with limit=200. Returns the 200 oldest-eligible rows, of
    // which 100 snoozed get deferred (one per chat, since each row has a
    // distinct chat_id) and the rest get sent.
    const tick1Rows = selectable.slice(0, 200);
    const db1 = mockD1([
      { match: "FROM telegram_pending_alerts p", rows: tick1Rows },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET not_before_at", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const tick1 = await drainPendingQueue(db1, "bot-token", 200);
    // Oldest 200 selectable rows: depending on created_at they include the
    // deliverable batch (created_at ~ now-600..-699), the snoozed batch
    // (~now-500..-599), and the quiet batch (~now-300..-399). We expect every
    // snoozed row in tick1's slice to be deferred and the rest sent.
    const snoozedInTick1 = tick1Rows.filter((r) => r.alert_snooze_until_ts != null && r.alert_snooze_until_ts > now);
    expect(tick1.deferred).toBe(snoozedInTick1.length);
    expect(tick1.attempted).toBe(tick1Rows.length - snoozedInTick1.length);
    expect(tick1.sent).toBe(tick1.attempted);
    expect(tick1.dropped).toBe(0);
    expect(tick1.retryQueued).toBe(0);

    // Quiet-hours rows in tick1: every send call must carry disableNotification:true.
    const quietChatsInTick1 = new Set(
      tick1Rows.filter((r) => r.quiet_hours_enabled === 1).map((r) => r.chat_id),
    );
    if (quietChatsInTick1.size > 0) {
      const quietCalls = mockSendToChat.mock.calls.filter(([chatId]) =>
        quietChatsInTick1.has(chatId as string),
      );
      expect(quietCalls.length).toBeGreaterThan(0);
      for (const [, , , options] of quietCalls) {
        expect(options).toMatchObject({ disableNotification: true });
      }
    }

    // Snoozed rows must NOT be sent. Snooze defer writes carry the snooze
    // expiry as the new not_before_at.
    const tick1History = db1.getHistory();
    const deferCalls = tick1History.filter((e) => e.sql.includes("SET not_before_at"));
    expect(deferCalls.length).toBe(snoozedInTick1.length);
    for (const call of deferCalls) {
      // bind order: notBeforeAt, nowSec, id
      expect(call.binds[0]).toBeGreaterThanOrEqual(futureSnooze);
    }

    // Tick 2: drain remaining selectable rows (i.e. the leftover 100).
    const tick2Rows = selectable.slice(200);
    const db2 = mockD1([
      { match: "FROM telegram_pending_alerts p", rows: tick2Rows },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET not_before_at", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);
    const tick2 = await drainPendingQueue(db2, "bot-token", 200);
    const snoozedInTick2 = tick2Rows.filter((r) => r.alert_snooze_until_ts != null && r.alert_snooze_until_ts > now);
    expect(tick2.attempted).toBe(tick2Rows.length - snoozedInTick2.length);
    expect(tick2.sent).toBe(tick2.attempted);
    expect(tick2.deferred).toBe(snoozedInTick2.length);

    // Tick 3: queue is empty (selectable rows already drained).
    const db3 = mockD1([
      { match: "FROM telegram_pending_alerts p", rows: [] },
    ]);
    const tick3 = await drainPendingQueue(db3, "bot-token", 200);
    expect(tick3.attempted).toBe(0);
    expect(tick3.deferred).toBe(0);

    // Fairness check: across the three ticks every non-snoozed, non-backoff
    // deliverable+quiet chat (200 distinct chats total) had at least one send
    // attempt logged. Snoozed and backoff chats are excluded by design.
    const eligibleChats = new Set(
      [...allRows]
        .filter((r) => r.created_at >= now - PENDING_TTL_SEC)
        .filter((r) => r.not_before_at == null)
        .filter((r) => r.alert_snooze_until_ts == null || r.alert_snooze_until_ts <= now)
        .map((r) => r.chat_id),
    );
    expect(eligibleChats.size).toBe(200);
    const attemptedChats = new Set(mockSendToChat.mock.calls.map(([chatId]) => chatId as string));
    for (const chatId of eligibleChats) {
      expect(attemptedChats.has(chatId)).toBe(true);
    }

    // Expired-row cleanup: simulate the production sweep. Expired rows are
    // dead-lettered before chunked terminal deletes.
    const expiredRows = allRows
      .filter((row) => row.created_at < now - PENDING_TTL_SEC)
      .map((row) => ({
        ...row,
        last_error_class: null,
        dedupe_key: `expired-${row.id}`,
        chunk_index: 0,
        priority: TELEGRAM_PENDING_PRIORITY.legacy,
        source_type: "risk_alert",
        alert_type: "depeg",
      }));
    const cleanupDb = mockD1([
      { match: "SELECT id, chat_id, message_html", rows: expiredRows },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [], runMeta: { changes: 100 } },
    ]);
    const expired = await cleanupExpiredPendingAlerts(cleanupDb, now);
    expect(expired).toBe(100);
    // No send call ever targeted an expired chat across the three ticks.
    for (let i = 0; i < 100; i++) {
      expect(attemptedChats.has(`expired-${i}`)).toBe(false);
    }
    // Likewise, no send call ever targeted a backoff-only chat.
    for (let i = 0; i < 100; i++) {
      expect(attemptedChats.has(`backoff-${i}`)).toBe(false);
    }
  });

  it("dead-letters expired pending rows before deleting them", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT id, chat_id, message_html",
        rows: [{
          id: 123,
          chat_id: "expired-chat",
          message_html: "<b>Expired</b>",
          created_at: now - PENDING_TTL_SEC - 60,
          attempts: 3,
          last_error_class: "rate_limit",
          dedupe_key: "expired-key",
          chunk_index: 0,
          priority: TELEGRAM_PENDING_PRIORITY.depeg,
          source_type: "risk_alert",
          alert_type: "depeg",
        }],
      },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE", rows: [], runMeta: { changes: 1 } },
    ]);

    const deleted = await cleanupExpiredPendingAlerts(db, now);

    expect(deleted).toBe(1);
    const deadLetter = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT INTO telegram_alert_dead_letters")
    );
    expect(deadLetter?.binds).toEqual([
      "pending:123:delivery:0",
      123,
      "expired-chat",
      "<b>Expired</b>",
      "risk_alert",
      "depeg",
      TELEGRAM_PENDING_PRIORITY.depeg,
      now - PENDING_TTL_SEC - 60,
      now,
      3,
      "rate_limit",
      "ttl_expired",
      "expired-key",
      0,
      null,
      null,
      null,
      null,
      "pending",
      null,
      0,
      null,
      null,
      null,
    ]);
  });
});
