import type { DatabaseSync } from "node:sqlite";
import type { Mock } from "vitest";
import type { MockTableConfig } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { serializePendingAlertScope, serializePendingMarkupPolicy } from "../../lib/telegram-pending-provenance";

export const DEFAULT_TELEGRAM_PENDING_D1_TABLES: MockTableConfig[] = [
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

export type PendingAlertSeed = {
  id?: number | null;
  chatId: string;
  html: string;
  disableNotification?: number;
  createdAt?: number;
  attempts?: number;
  notBeforeAt?: number | null;
  dedupeKey?: string | null;
  chunkIndex?: number | null;
  priority?: number | null;
  sourceType?: string | null;
  alertType?: string | null;
  expiresAt?: number | null;
  updatedAt?: number;
  lastErrorClass?: string | null;
  retryAfterSec?: number | null;
  deliveryState?: "pending" | "sending" | "execution_unknown" | "sent_cleanup";
  deliveryOwner?: string | null;
  deliveryGeneration?: number;
  deliveryStartedAt?: number | null;
  deliveryCompletedAt?: number | null;
  deliveryClaimExpiresAt?: number | null;
  sourceEventId?: string | null;
  alertScopeJson?: string | null;
  preferenceGeneration?: number | null;
  markupPolicyJson?: string | null;
};

export type PendingQueryRow = Record<string, unknown>;

/** A complete row for the mocked candidate/claimed-row SELECTs. */
export function makePendingQueryRow(
  id: number,
  overrides: PendingQueryRow = {},
): PendingQueryRow {
  return {
    id,
    chat_id: `chat-${id}`,
    message_html: `<b>Alert ${id}</b>`,
    disable_notification: 0,
    created_at: 1_000,
    expires_at: 10_000,
    attempts: 0,
    not_before_at: null,
    priority: 50,
    source_type: "legacy",
    alert_type: null,
    dedupe_key: null,
    chunk_index: 0,
    last_error_class: null,
    source_event_id: null,
    alert_scope_json: null,
    preference_generation: null,
    markup_policy_json: null,
    delivery_state: "pending",
    delivery_owner: null,
    delivery_generation: 0,
    delivery_started_at: null,
    delivery_completed_at: null,
    delivery_claim_expires_at: null,
    alert_snooze_until_ts: null,
    quiet_hours_enabled: 0,
    quiet_hours_start_utc: null,
    quiet_hours_end_utc: null,
    timezone: null,
    ...overrides,
  };
}

export function makePendingQueryRows(
  count: number,
  overrides: (index: number) => PendingQueryRow = (index) => ({
    chat_id: `chat-${index}`,
    message_html: `msg${index}`,
    id: index + 1,
  }),
): PendingQueryRow[] {
  return Array.from({ length: count }, (_, index) => makePendingQueryRow(index + 1, overrides(index)));
}

export function insertPendingSqlite(
  sqlite: DatabaseSync,
  row: PendingAlertSeed,
  now = Math.floor(Date.now() / 1000),
): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_pending_alerts (
       id, chat_id, message_html, disable_notification, created_at, attempts,
       not_before_at, dedupe_key, chunk_index, priority, source_type, alert_type,
       expires_at, updated_at, last_error_class, retry_after_sec, delivery_state,
       delivery_owner, delivery_generation, delivery_started_at, delivery_completed_at,
       delivery_claim_expires_at, source_event_id, alert_scope_json,
       preference_generation, markup_policy_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id ?? null,
      row.chatId,
      row.html,
      row.disableNotification ?? 0,
      row.createdAt ?? now,
      row.attempts ?? 0,
      row.notBeforeAt ?? null,
      row.dedupeKey ?? null,
      row.chunkIndex ?? 0,
      row.priority ?? 50,
      row.sourceType ?? "legacy",
      row.alertType ?? null,
      row.expiresAt ?? null,
      row.updatedAt ?? row.createdAt ?? now,
      row.lastErrorClass ?? null,
      row.retryAfterSec ?? null,
      row.deliveryState ?? "pending",
      row.deliveryOwner ?? null,
      row.deliveryGeneration ?? 0,
      row.deliveryStartedAt ?? null,
      row.deliveryCompletedAt ?? null,
      row.deliveryClaimExpiresAt ?? null,
      row.sourceEventId ?? null,
      row.alertScopeJson ?? null,
      row.preferenceGeneration ?? null,
      row.markupPolicyJson ?? null,
    );
}

export type TelegramSourceEventSeed = {
  sourceEventId: string;
  planGeneration?: number;
  detectedAt?: number;
  expiresAt?: number;
};

/** Seeds the source event required by a target row with a plan generation. */
export function insertSourceEventSqlite(
  sqlite: DatabaseSync,
  row: TelegramSourceEventSeed,
  now = Math.floor(Date.now() / 1000),
): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_events (
         source_event_id, status, detected_at, expires_at, event_payload, baseline_payload,
         target_plan_state, target_plan_generation
       ) VALUES (?, 'planned', ?, ?, '{}', '{}', 'materializing', ?)`,
    )
    .run(
      row.sourceEventId,
      row.detectedAt ?? now,
      row.expiresAt ?? now + 3_600,
      row.planGeneration ?? 1,
    );
}

/** Seeds a subscriber row satisfying the production NOT NULL columns. */
export type TelegramSubscriberSeed = {
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
};

export function insertSubscriberSqlite(sqlite: DatabaseSync, row: TelegramSubscriberSeed): void {
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

export type TelegramAlertJobSeed = {
  jobId: string;
  alertType: string;
  sourceEventId: string;
  severity: string;
  createdAt?: number;
  expiresAt?: number;
  status?: "discovered" | "queued" | "sent" | "degraded" | "expired";
  targetCount?: number;
  enqueuedCount?: number;
  metadata?: string;
};

export type TelegramAlertJobTargetSeed = {
  jobId: string;
  targetKey: string;
  chatId: string;
  alertType: string;
  pendingDedupeKey: string;
  createdAt?: number;
  status?: "planned" | "queued" | "sent" | "failed" | "expired";
  effectState?: "unstarted" | "claimed" | "sending" | "complete" | "execution_unknown";
  sourceEventId?: string | null;
  planGeneration?: number | null;
  chunkIndex?: number;
  messageHtml?: string | null;
  disableNotification?: number | null;
  alertScopeJson?: string | null;
  preferenceGeneration?: number | null;
  markupPolicyJson?: string | null;
};

function insertAlertJobSqlite(sqlite: DatabaseSync, row: TelegramAlertJobSeed, now: number): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at,
         status, target_count, enqueued_count, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.jobId,
      row.alertType,
      row.sourceEventId,
      row.severity,
      row.createdAt ?? now,
      row.expiresAt ?? now + 3_600,
      row.status ?? "queued",
      row.targetCount ?? 1,
      row.enqueuedCount ?? row.targetCount ?? 1,
      row.metadata ?? "{}",
    );
}

function insertAlertJobTargetSqlite(sqlite: DatabaseSync, row: TelegramAlertJobTargetSeed, now: number): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, effect_state, source_event_id, plan_generation,
         message_html, disable_notification, alert_scope_json, preference_generation, markup_policy_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.jobId,
      row.targetKey,
      row.chatId,
      row.chunkIndex ?? 0,
      row.alertType,
      row.status ?? "queued",
      row.pendingDedupeKey,
      row.createdAt ?? now,
      row.effectState ?? "unstarted",
      row.sourceEventId ?? null,
      row.planGeneration ?? null,
      row.messageHtml ?? null,
      row.disableNotification ?? null,
      row.alertScopeJson ?? null,
      row.preferenceGeneration ?? null,
      row.markupPolicyJson ?? null,
    );
}

export function insertRiskPendingSqlite(
  sqlite: DatabaseSync,
  options: { id: number; chatId: string; html?: string; dedupeKey?: string; sourceEventId?: string; generation?: number } = { id: 1, chatId: "risk-chat" },
  now = Math.floor(Date.now() / 1000),
): void {
  const generation = options.generation ?? 1;
  const sourceEventId = options.sourceEventId ?? `source-${options.id}`;
  insertSubscriberSqlite(sqlite, { chatId: options.chatId, preferenceGeneration: generation, globalAlertDews: 1, globalAlertDepeg: 1, globalAlertSafety: 1 });
  insertPendingSqlite(sqlite, {
    id: options.id,
    chatId: options.chatId,
    html: options.html ?? `<b>Risk ${options.id}</b>`,
    createdAt: now - 60,
    expiresAt: now + 600,
    dedupeKey: options.dedupeKey ?? `dedupe-${options.id}`,
    sourceType: "risk_alert",
    alertType: "dews",
    sourceEventId,
    alertScopeJson: serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]),
    preferenceGeneration: generation,
    markupPolicyJson: serializePendingMarkupPolicy({}),
  }, now);
}

export function createClaimContentionD1(sqlite: DatabaseSync): D1Database & {
  getHistory(): Array<{ sql: string; binds: unknown[] }>;
  getOwner(): string | null;
} {
  const inner = createSqliteD1(sqlite);
  const history: Array<{ sql: string; binds: unknown[] }> = [];
  let winner: string | null = null;
  let reads = 0;
  let release: (() => void) | undefined;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => {
    const bound = values.length ? inner.prepare(sql).bind(...values) : inner.prepare(sql);
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      first: async <T>() => { history.push({ sql, binds: [...values] }); return bound.first<T>(); },
      all: async <T>() => {
        history.push({ sql, binds: [...values] });
        const result = await bound.all<T>();
        if (sql.includes("SELECT p.id") && sql.includes("processing_owner IS NULL")) {
          reads++;
          if (reads === 2) release?.();
          await bothRead;
        }
        return result;
      },
      run: async () => {
        history.push({ sql, binds: [...values] });
        const result = await bound.run();
        if (sql.includes("SET processing_owner = ?") && Number(result.meta?.changes ?? 0) > 0) winner = String(values[0]);
        return result;
      },
    } as unknown as D1PreparedStatement;
  };
  return makeNoopD1({
    prepare: (sql: string) => statement(sql),
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((item) => item.run())),
    exec: async (sql: string) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    dump: async () => new ArrayBuffer(0),
    getHistory: () => history.map((entry) => ({ sql: entry.sql, binds: [...entry.binds] })),
    getOwner: () => winner,
  });
}

export function insertAlertJobFixture(sqlite: DatabaseSync, row: TelegramAlertJobSeed, now: number): void {
  insertAlertJobSqlite(sqlite, row, now);
}

export function insertAlertJobTargetFixture(sqlite: DatabaseSync, row: TelegramAlertJobTargetSeed, now: number): void {
  insertAlertJobTargetSqlite(sqlite, row, now);
}

export function insertRecapDeliveryFixture(
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
    markupPolicyJson: serializePendingMarkupPolicy({ replyMarkup: { inline_keyboard: [[{ text: "View watchlist", web_app: { url: "https://pharos.watch/pharoswatchbot" } }]] } }),
  });
  return { chatId, recapKey };
}

export type PendingQueueScenarioOverrides = {
  now?: number;
  subscriber?: TelegramSubscriberSeed | null;
  sourceEvent?: TelegramSourceEventSeed | null;
  job?: TelegramAlertJobSeed | null;
  target?: TelegramAlertJobTargetSeed | null;
  pending?: PendingAlertSeed | readonly PendingAlertSeed[];
};

export type PendingQueueScenario = {
  sqlite: DatabaseSync;
  db: D1Database;
  now: number;
};

/**
 * Creates a latest-schema SQLite fixture, seeds the requested typed rows, and
 * always closes the database after the callback settles.
 */
export async function withPendingQueueScenario<T>(
  overrides: PendingQueueScenarioOverrides,
  callback: (scenario: PendingQueueScenario) => Promise<T> | T,
): Promise<T> {
  const { sqlite, db } = createLatestSchemaSqlite();
  const now = overrides.now ?? Math.floor(Date.now() / 1000);
  try {
    if (overrides.subscriber) {
      insertSubscriberSqlite(sqlite, {
        ...overrides.subscriber,
        createdAt: overrides.subscriber.createdAt ?? now,
        lastActiveAt: overrides.subscriber.lastActiveAt ?? now,
      });
    }
    if (overrides.sourceEvent) insertSourceEventSqlite(sqlite, overrides.sourceEvent, now);
    if (overrides.job) insertAlertJobSqlite(sqlite, overrides.job, now);
    if (overrides.target) insertAlertJobTargetSqlite(sqlite, overrides.target, now);
    const pendingRows = overrides.pending == null
      ? []
      : Array.isArray(overrides.pending) ? overrides.pending : [overrides.pending];
    for (const row of pendingRows) insertPendingSqlite(sqlite, row, now);
    return await callback({ sqlite, db, now });
  } finally {
    sqlite.close();
  }
}

export type TelegramDeliveryResult = {
  ok: boolean;
  blocked: boolean;
  retryable: boolean;
  permanentFailure: boolean;
  statusCode: number | null;
  errorClass: string | null;
  delivery: "sent" | "blocked" | "retryable_failure" | "permanent_failure";
  retryAfterSec: number | null;
  rateLimitScope?: "chat" | "global";
  migrateToChatId?: string;
};

export function makeTelegramDeliveryResult(
  overrides: Partial<TelegramDeliveryResult> = {},
): TelegramDeliveryResult {
  return {
    ok: true,
    blocked: false,
    retryable: false,
    permanentFailure: false,
    statusCode: 200,
    errorClass: null,
    delivery: "sent",
    retryAfterSec: null,
    ...overrides,
  };
}

export type TelegramRateLimitScope = "chat" | "global";

export const TELEGRAM_SENT_RESULT = Object.freeze(makeTelegramDeliveryResult());
export const TELEGRAM_RETRYABLE_RESULT = Object.freeze(makeTelegramDeliveryResult({
  ok: false,
  retryable: true,
  statusCode: 503,
  errorClass: "server_error",
  delivery: "retryable_failure",
}));
export const TELEGRAM_PERMANENT_RESULT = Object.freeze(makeTelegramDeliveryResult({
  ok: false,
  permanentFailure: true,
  statusCode: 400,
  errorClass: "bad_request",
  delivery: "permanent_failure",
}));
export const TELEGRAM_BLOCKED_RESULT = Object.freeze(makeTelegramDeliveryResult({
  ok: false,
  blocked: true,
  permanentFailure: true,
  statusCode: 403,
  errorClass: "blocked",
  delivery: "blocked",
}));
export const TELEGRAM_CHAT_RATE_LIMIT_RESULT = Object.freeze(makeTelegramDeliveryResult({
  ok: false,
  retryable: true,
  statusCode: 429,
  errorClass: "rate_limit",
  delivery: "retryable_failure",
  retryAfterSec: 30,
  rateLimitScope: "chat",
}));
export const TELEGRAM_GLOBAL_RATE_LIMIT_RESULT = Object.freeze(makeTelegramDeliveryResult({
  ok: false,
  retryable: true,
  statusCode: 429,
  errorClass: "rate_limit",
  delivery: "retryable_failure",
  retryAfterSec: 30,
  rateLimitScope: "global",
}));

export function makeTelegramSentResult(overrides: Partial<TelegramDeliveryResult> = {}): TelegramDeliveryResult {
  return makeTelegramDeliveryResult({ ...TELEGRAM_SENT_RESULT, ...overrides });
}

export function makeTelegramRetryableResult(
  overrides: Partial<TelegramDeliveryResult> = {},
): TelegramDeliveryResult {
  return makeTelegramDeliveryResult({ ...TELEGRAM_RETRYABLE_RESULT, ...overrides });
}

export function makeTelegramPermanentResult(
  overrides: Partial<TelegramDeliveryResult> = {},
): TelegramDeliveryResult {
  return makeTelegramDeliveryResult({ ...TELEGRAM_PERMANENT_RESULT, ...overrides });
}

export function makeTelegramBlockedResult(
  overrides: Partial<TelegramDeliveryResult> = {},
): TelegramDeliveryResult {
  return makeTelegramDeliveryResult({ ...TELEGRAM_BLOCKED_RESULT, ...overrides });
}

export function makeTelegramRateLimitedResult(options: {
  rateLimitScope: TelegramRateLimitScope;
  retryAfterSec?: number | null;
  statusCode?: number;
  errorClass?: string | null;
}): TelegramDeliveryResult {
  const base = options.rateLimitScope === "global"
    ? TELEGRAM_GLOBAL_RATE_LIMIT_RESULT
    : TELEGRAM_CHAT_RATE_LIMIT_RESULT;
  return makeTelegramDeliveryResult({
    ...base,
    statusCode: options.statusCode ?? 429,
    errorClass: options.errorClass === undefined ? "rate_limit" : options.errorClass,
    retryAfterSec: options.retryAfterSec === undefined ? 30 : options.retryAfterSec,
    rateLimitScope: options.rateLimitScope,
  });
}

type TelegramPendingMockSet = {
  sendToChat: Mock;
  migrateTelegramChatId: Mock;
  transport: { claim: Mock; readPause: Mock; record: Mock };
  sendBatchSize: number;
};

/**
 * Reset the pending-queue mocks to their default allow-everything posture.
 *
 * The `vi.mock` factories and the mock identifiers themselves have to stay in
 * each suite because vitest hoists them per file, so the mocks are passed in
 * rather than owned here.
 */
export function resetTelegramPendingMocks({
  sendToChat,
  migrateTelegramChatId,
  transport,
  sendBatchSize,
}: TelegramPendingMockSet): void {
  sendToChat.mockReset();
  migrateTelegramChatId.mockReset().mockResolvedValue(undefined);
  transport.claim.mockReset().mockResolvedValue({
    allowed: true,
    mode: "pending",
    maxDistinctChats: sendBatchSize,
    reason: "closed",
    circuitGeneration: 0,
    probeOwner: null,
    probeGeneration: null,
    pauseGeneration: null,
    deferUntil: null,
  });
  transport.readPause.mockReset().mockResolvedValue(null);
  transport.record.mockReset().mockResolvedValue({ state: "closed", generation: 0 });
}
