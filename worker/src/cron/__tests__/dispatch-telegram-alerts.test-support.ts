import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { mockCircuitBreaker } from "../../test-helpers/cron";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { getAlertSafetySourceGeneration } from "../../lib/alert-safety-source-cache";
import type { CronProgressUpdate } from "../../lib/cron-logger";

const STABLECOINS_CACHE_WITH_USDC = JSON.stringify({
  peggedAssets: [
    {
      id: "usdc-circle",
      symbol: "USDC",
      name: "USD Coin",
      pegType: "peggedUSD",
      price: 1,
      circulating: { peggedUSD: 50_000_000_000 },
    },
  ],
});

const mockShouldAttemptFetch = vi.fn();
const mockRecordOutcome = vi.fn();
const mockInspectLegacyOverflowBacklog = vi.fn();
const fixtureSqliteDatabases: DatabaseSync[] = [];

function safetyScoreIdentity(publicationGenerationId: string) {
  return {
    model: "v8" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "7.10",
    evaluationBuildDigest: "a".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
    publicationGenerationId,
  };
}

vi.mock("../../lib/circuit-breaker", () =>
  mockCircuitBreaker({
    shouldAttemptFetchFn: mockShouldAttemptFetch,
    recordOutcomeFn: mockRecordOutcome,
  }),
);

vi.mock("../telegram-legacy-overflow-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram-legacy-overflow-import")>();
  return {
    ...actual,
    inspectAndImportLegacyOverflowBacklog: mockInspectLegacyOverflowBacklog,
  };
});

const mockSendToChat = vi.fn();
const mockSendBatch = vi.fn();

export interface TelegramDeliveryResult {
  ok: boolean;
  blocked: boolean;
  retryable: boolean;
  permanentFailure: boolean;
  statusCode: number;
  errorClass: string | null;
  delivery: string;
  retryAfterSec: number | null;
  rateLimitScope?: "chat" | "global";
}

export interface TelegramDeliveryTranscriptEntry {
  chatId: string;
  html: string;
  botToken: string;
  options: Record<string, unknown>;
}

const telegramDeliveryTranscript: TelegramDeliveryTranscriptEntry[] = [];
let scriptedDeliveryResults: TelegramDeliveryResult[] = [];
const scriptedDeliveryResultsByChat = new Map<string, TelegramDeliveryResult[]>();

const DEFAULT_DELIVERY_RESULT: TelegramDeliveryResult = {
  ok: true,
  blocked: false,
  retryable: false,
  permanentFailure: false,
  statusCode: 200,
  errorClass: null,
  delivery: "sent",
  retryAfterSec: null,
};

function recordDisabledTelegramDelivery(
  chatId: string,
  html: string,
  botToken: string,
  options: Record<string, unknown>,
): TelegramDeliveryResult {
  telegramDeliveryTranscript.push({ chatId, html, botToken, options });
  const resultsForChat = scriptedDeliveryResultsByChat.get(chatId);
  if (resultsForChat?.length) return resultsForChat.shift()!;
  return scriptedDeliveryResults.shift() ?? DEFAULT_DELIVERY_RESULT;
}

function scriptTelegramDeliveries(...results: TelegramDeliveryResult[]): void {
  scriptedDeliveryResults = [...results];
}

function scriptTelegramDeliveriesForChat(chatId: string, ...results: TelegramDeliveryResult[]): void {
  scriptedDeliveryResultsByChat.set(chatId, [...results]);
}

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return {
    ...actual,
    sendToChat: mockSendToChat,
    sendBatch: mockSendBatch,
  };
});

// Count `formatConsolidatedMessage` invocations while preserving behavior, so the
// C102 budget-before-format reorder can be asserted (format-count <= fresh budget
// + allowance, not once per candidate).
const formatConsolidatedMessageSpy = vi.fn();
vi.mock("../../lib/telegram-alerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram-alerts")>();
  return {
    ...actual,
    formatConsolidatedMessage: (...args: Parameters<typeof actual.formatConsolidatedMessage>) => {
      formatConsolidatedMessageSpy(...args);
      return actual.formatConsolidatedMessage(...args);
    },
  };
});

const { dispatchTelegramAlerts } = await import("../dispatch-telegram-alerts");
const { deliverTelegramSubscriberQueue } = await import("../dispatch-telegram-delivery");
const { pruneOverflowPlanBacklogForChat } = await import("../dispatch-telegram-overflow");
const { buildDedupeKey, emptyDrainResult } = await import("../telegram-pending");
const { TELEGRAM_MAX_MESSAGES_PER_RUN, TELEGRAM_FORMAT_BUDGET_ALLOWANCE, TELEGRAM_DISPATCH_SOFT_DEADLINE_MS } =
  await import("../../lib/telegram-constants");

function makeSafetySourceCache(
  snapshot: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>,
  publishedAt: number,
  generation = getAlertSafetySourceGeneration(),
) {
  const publicationGenerationId = `report-cards:7.10:${publishedAt}`;
  const notRatedIds = Object.entries(snapshot).flatMap(([id, row]) => (row.score === null ? [id] : []));
  return {
    value: JSON.stringify({
      generation,
      safetyScoreIdentity: safetyScoreIdentity(publicationGenerationId),
      publicationGenerationId,
      methodologyVersion: "7.10",
      publishedAt,
      completeness: {
        generationId: publicationGenerationId,
        methodologyVersion: "7.10",
        expectedCount: Object.keys(snapshot).length,
        scoredCount: Object.keys(snapshot).length - notRatedIds.length,
        notRatedCount: notRatedIds.length,
        notRatedIds,
      },
      snapshot,
    }),
    updatedAt: publishedAt,
  };
}

function makeSafetySnapshotCache(
  snapshot: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>,
  generation = getAlertSafetySourceGeneration(),
) {
  return {
    value: JSON.stringify({
      generation,
      safetyScoreIdentity: safetyScoreIdentity("report-cards:7.10:baseline"),
      snapshot,
    }),
    updatedAt: Math.floor(Date.now() / 1000) - 60,
  };
}

function makeDewsOverflowPlan(now: number, chatId = "chat-overflow") {
  return {
    chatId,
    alertType: "dews" as const,
    estimatedChunks: 1,
    entry: {
      lastActiveAt: now,
      alerts: {
        dews: [
          {
            stablecoinId: "usdc-circle",
            symbol: "USDC",
            oldBand: "CALM",
            newBand: "WARNING",
            score: 55,
            topSignals: [],
          },
        ],
        depegTriggered: [],
        depegResolved: [],
        depegWorsening: [],
        safety: [],
        launch: [],
        reserve: [],
      },
      quietHoursEnabled: false,
      quietHoursStartUtc: null,
      quietHoursEndUtc: null,
      timezone: null,
      specificCount: 1,
      globalCount: 0,
    },
  };
}

function parseLogRecords(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}
function resetDispatchTelegramAlertsTest() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));

  formatConsolidatedMessageSpy.mockReset();
  mockShouldAttemptFetch.mockReset();
  mockRecordOutcome.mockReset();
  mockInspectLegacyOverflowBacklog.mockReset();
  mockSendToChat.mockReset();
  mockSendBatch.mockReset();
  telegramDeliveryTranscript.length = 0;
  scriptedDeliveryResults = [];
  scriptedDeliveryResultsByChat.clear();

  mockShouldAttemptFetch.mockResolvedValue(true);
  mockRecordOutcome.mockResolvedValue(undefined);
  mockInspectLegacyOverflowBacklog.mockResolvedValue({
    state: "absent",
    digest: null,
    sourceEventId: null,
    observedBytes: 0,
    observedPlanCount: null,
    importCursor: 0,
    importedTargetCount: 0,
    errorClass: null,
  });
  mockSendToChat.mockImplementation(async (chatId, html, botToken, options) =>
    recordDisabledTelegramDelivery(chatId, html, botToken, options ?? {}),
  );

  // Default sendBatch: delegate each message to mockSendToChat
  mockSendBatch.mockImplementation(
    async (
      messages: Array<{
        chatId: string;
        html: string;
        disableNotification: boolean;
        linkPreviewOptions?: unknown;
        replyMarkup?: unknown;
      }>,
      _botToken: string,
    ) => {
      const results = [];
      for (const msg of messages) {
        const result = await mockSendToChat(msg.chatId, msg.html, _botToken, {
          ...(msg.linkPreviewOptions
            ? { linkPreviewOptions: msg.linkPreviewOptions }
            : { disableWebPagePreview: true }),
          disableNotification: msg.disableNotification,
          replyMarkup: msg.replyMarkup,
        });
        results.push({ chatId: msg.chatId, ...result });
      }
      return results;
    },
  );
}

function cleanupDispatchTelegramAlertsTest() {
  vi.useRealTimers();
  while (fixtureSqliteDatabases.length > 0) fixtureSqliteDatabases.pop()?.close();
}

type AlertFamilySeed = "dews" | "depeg" | "safety" | "launch" | "reserve";

type AlertFlags = Partial<Record<AlertFamilySeed, boolean>>;

export interface DispatchSubscriberSeed {
  chatId: string;
  createdAt?: number;
  lastActiveAt?: number;
  preferenceGeneration?: number;
  snoozeUntil?: number | null;
  quietHoursEnabled?: boolean;
  quietHoursStartUtc?: number | null;
  quietHoursEndUtc?: number | null;
  timezone?: string | null;
  global?: AlertFlags;
  direct?: AlertFlags;
  globalDepegWorseningBpsStep?: number | null;
  consecutiveBlockCount?: number;
  consecutiveBlockFirstAt?: number | null;
}

export interface DispatchSubscriptionSeed {
  chatId: string;
  stablecoinId: string;
  alerts?: AlertFlags;
  overrides?: AlertFlags;
  dewsMinBand?: string | null;
  safetyMode?: string | null;
  depegWorseningBpsStep?: number | null;
  snoozeUntil?: number | null;
}

export interface DispatchPresetSeed {
  chatId: string;
  presetId: string;
  alerts?: Pick<AlertFlags, "dews" | "depeg" | "safety">;
  depegWorseningBpsStep?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface DispatchDewsSeed {
  stablecoinId: string;
  score?: number;
  band?: "CALM" | "WATCH" | "ALERT" | "WARNING" | "DANGER";
  signals?: Record<string, unknown>;
  computedAt?: number;
}

export interface DispatchDepegSeed {
  stablecoinId: string;
  symbol?: string;
  direction?: "above" | "below";
  peakDeviationBps?: number;
  startedAt?: number;
  endedAt?: number | null;
  startPrice?: number;
  peakPrice?: number | null;
  recoveryPrice?: number | null;
  pegReference?: number;
}

export interface DispatchSafetySeed {
  stablecoinId: string;
  grade: string;
  score?: number | null;
  prevGrade?: string | null;
  prevScore?: number | null;
  methodologyVersion?: string;
  recordedAt?: number;
}

export interface DispatchPendingSeed {
  id?: number;
  chatId: string;
  html: string;
  createdAt?: number;
  attempts?: number;
  notBeforeAt?: number | null;
  dedupeKey?: string | null;
  chunkIndex?: number | null;
  priority?: number;
  sourceType?: string;
  alertType?: AlertFamilySeed | null;
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
}

export interface DispatchSourceEventSeed {
  sourceEventId: string;
  schemaVersion?: number;
  status?: "resolving" | "planned" | "baseline_committed" | "complete" | "expired";
  detectedAt?: number;
  expiresAt?: number;
  eventPayload: string;
  baselinePayload: string;
  attemptCount?: number;
  lastAttemptAt?: number | null;
  lastErrorClass?: string | null;
  baselineCommittedAt?: number | null;
  completedAt?: number | null;
  targetPlanState?:
    "unstarted" | "capturing" | "planning" | "materializing" | "ready" | "delivery_open" | "degraded" | "expired";
  targetPlanGeneration?: number;
}

export interface DispatchTargetSeed {
  sourceEventId: string;
  chatId: string;
  alertType?: AlertFamilySeed;
  targetKey?: string;
  pendingDedupeKey?: string;
  planGeneration?: number;
  status?: "planned" | "queued" | "sent" | "failed" | "expired";
}

export interface DispatchSeed {
  cache?: Record<string, unknown>;
  dews?: DispatchDewsSeed[];
  depegs?: DispatchDepegSeed[];
  safety?: DispatchSafetySeed[];
  subscribers?: DispatchSubscriberSeed[];
  subscriptions?: DispatchSubscriptionSeed[];
  presets?: DispatchPresetSeed[];
  pending?: DispatchPendingSeed[];
  sourceEvents?: DispatchSourceEventSeed[];
  targets?: DispatchTargetSeed[];
}

export type DispatchOperation = "active-snoozes" | "preset-subscribers" | "resolved-depeg-lookup" | "subscriber-fanout";

export type DispatchFaultOperation = Extract<DispatchOperation, "active-snoozes" | "preset-subscribers">;

export interface DispatchOperationTranscriptEntry {
  operation: DispatchOperation;
  binds: unknown[];
}

export interface DispatchOperationFault {
  operation: DispatchFaultOperation;
  error: Error;
  remaining?: number;
}

export interface DispatchHarness {
  sqlite: DatabaseSync;
  db: D1Database;
  seed: (input: DispatchSeed) => void;
  cache: (key: string, value: unknown, updatedAt?: number) => void;
  operations: DispatchOperationTranscriptEntry[];
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function seedCacheRow(sqlite: DatabaseSync, key: string, value: unknown, updatedAt = nowSec()): void {
  sqlite
    .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .run(key, typeof value === "string" ? value : JSON.stringify(value), updatedAt);
}

function alertFlag(flags: AlertFlags | undefined, family: AlertFamilySeed): number {
  return flags?.[family] === true ? 1 : 0;
}

function seedSubscriber(sqlite: DatabaseSync, input: DispatchSubscriberSeed): void {
  const current = nowSec();
  sqlite
    .prepare(
      `INSERT INTO telegram_subscribers (
       chat_id, created_at, last_active_at, preference_generation,
       alert_snooze_until_ts, quiet_hours_enabled, quiet_hours_start_utc,
       quiet_hours_end_utc, timezone, global_alert_dews, global_alert_depeg,
       global_alert_safety, global_alert_launch, global_alert_reserve,
       global_depeg_worsening_bps_step, consecutive_block_count,
       consecutive_block_first_at, alert_dews, alert_depeg, alert_safety,
       alert_launch, alert_reserve
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.chatId,
      input.createdAt ?? current - 1,
      input.lastActiveAt ?? current,
      input.preferenceGeneration ?? 0,
      input.snoozeUntil ?? null,
      input.quietHoursEnabled === true ? 1 : 0,
      input.quietHoursStartUtc ?? null,
      input.quietHoursEndUtc ?? null,
      input.timezone ?? null,
      alertFlag(input.global, "dews"),
      alertFlag(input.global, "depeg"),
      alertFlag(input.global, "safety"),
      alertFlag(input.global, "launch"),
      alertFlag(input.global, "reserve"),
      input.globalDepegWorseningBpsStep ?? null,
      input.consecutiveBlockCount ?? 0,
      input.consecutiveBlockFirstAt ?? null,
      alertFlag(input.direct, "dews"),
      alertFlag(input.direct, "depeg"),
      alertFlag(input.direct, "safety"),
      alertFlag(input.direct, "launch"),
      alertFlag(input.direct, "reserve"),
    );
}

function seedSubscription(sqlite: DatabaseSync, input: DispatchSubscriptionSeed): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_subscriptions (
       chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety,
       alert_launch, alert_reserve, dews_min_band, safety_mode,
       depeg_worsening_bps_step, alert_snooze_until_ts, alert_dews_override,
       alert_depeg_override, alert_safety_override, alert_launch_override,
       alert_reserve_override
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.chatId,
      input.stablecoinId,
      alertFlag(input.alerts, "dews"),
      alertFlag(input.alerts, "depeg"),
      alertFlag(input.alerts, "safety"),
      alertFlag(input.alerts, "launch"),
      alertFlag(input.alerts, "reserve"),
      input.dewsMinBand ?? null,
      input.safetyMode ?? null,
      input.depegWorseningBpsStep ?? null,
      input.snoozeUntil ?? null,
      alertFlag(input.overrides, "dews"),
      alertFlag(input.overrides, "depeg"),
      alertFlag(input.overrides, "safety"),
      alertFlag(input.overrides, "launch"),
      alertFlag(input.overrides, "reserve"),
    );
}

function seedPreset(sqlite: DatabaseSync, input: DispatchPresetSeed): void {
  const current = nowSec();
  sqlite
    .prepare(
      `INSERT INTO telegram_preset_subscriptions (
       chat_id, preset_id, alert_dews, alert_depeg, alert_safety,
       depeg_worsening_bps_step, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.chatId,
      input.presetId,
      input.alerts?.dews === true ? 1 : 0,
      input.alerts?.depeg === true ? 1 : 0,
      input.alerts?.safety === true ? 1 : 0,
      input.depegWorseningBpsStep ?? null,
      input.createdAt ?? current,
      input.updatedAt ?? current,
    );
}

function seedDews(sqlite: DatabaseSync, input: DispatchDewsSeed): void {
  sqlite
    .prepare(
      "INSERT INTO stress_signals (stablecoin_id, computed_at, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      input.stablecoinId,
      input.computedAt ?? nowSec(),
      input.score ?? 42,
      input.band ?? "ALERT",
      JSON.stringify(input.signals ?? {}),
    );
}

function seedDepeg(sqlite: DatabaseSync, input: DispatchDepegSeed): void {
  sqlite
    .prepare(
      `INSERT INTO depeg_events (
       stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference
     ) VALUES (?, ?, 'peggedUSD', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.stablecoinId,
      input.symbol ?? input.stablecoinId.toUpperCase(),
      input.direction ?? "below",
      input.peakDeviationBps ?? 125,
      input.startedAt ?? nowSec() - 300,
      input.endedAt ?? null,
      input.startPrice ?? 0.9875,
      input.peakPrice ?? null,
      input.recoveryPrice ?? null,
      input.pegReference ?? 1,
    );
}

function seedSafety(sqlite: DatabaseSync, input: DispatchSafetySeed): void {
  sqlite
    .prepare(
      `INSERT INTO safety_grade_history (
       stablecoin_id, recorded_at, grade, score, prev_grade, prev_score, methodology_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.stablecoinId,
      input.recordedAt ?? nowSec(),
      input.grade,
      input.score ?? null,
      input.prevGrade ?? null,
      input.prevScore ?? null,
      input.methodologyVersion ?? "7.10",
    );
}

function seedPending(sqlite: DatabaseSync, input: DispatchPendingSeed): void {
  const current = nowSec();
  sqlite
    .prepare(
      `INSERT INTO telegram_pending_alerts (
       id, chat_id, message_html, disable_notification, created_at, attempts,
       not_before_at, dedupe_key, chunk_index, priority, source_type, alert_type,
       expires_at, updated_at, last_error_class, retry_after_sec, delivery_state,
       delivery_owner, delivery_generation, delivery_started_at, delivery_completed_at,
       delivery_claim_expires_at, source_event_id, alert_scope_json,
       preference_generation, markup_policy_json
     ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id ?? null,
      input.chatId,
      input.html,
      input.createdAt ?? current,
      input.attempts ?? 0,
      input.notBeforeAt ?? null,
      input.dedupeKey ?? null,
      input.chunkIndex ?? null,
      input.priority ?? 50,
      input.sourceType ?? "risk_alert",
      input.alertType ?? null,
      input.expiresAt ?? null,
      input.updatedAt ?? input.createdAt ?? current,
      input.lastErrorClass ?? null,
      input.retryAfterSec ?? null,
      input.deliveryState ?? "pending",
      input.deliveryOwner ?? null,
      input.deliveryGeneration ?? 0,
      input.deliveryStartedAt ?? null,
      input.deliveryCompletedAt ?? null,
      input.deliveryClaimExpiresAt ?? null,
      input.sourceEventId ?? null,
      input.alertScopeJson ?? null,
      input.preferenceGeneration ?? null,
      input.markupPolicyJson ?? null,
    );
}

function seedSourceEvent(sqlite: DatabaseSync, input: DispatchSourceEventSeed): void {
  const current = nowSec();
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_events (
       source_event_id, schema_version, status, detected_at, expires_at,
       event_payload, baseline_payload, attempt_count, last_attempt_at,
       last_error_class, baseline_committed_at, completed_at, target_plan_state,
       target_plan_generation
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sourceEventId,
      input.schemaVersion ?? 1,
      input.status ?? "planned",
      input.detectedAt ?? current,
      input.expiresAt ?? current + 3_600,
      input.eventPayload,
      input.baselinePayload,
      input.attemptCount ?? 0,
      input.lastAttemptAt ?? null,
      input.lastErrorClass ?? null,
      input.baselineCommittedAt ?? null,
      input.completedAt ?? null,
      input.targetPlanState ?? "unstarted",
      input.targetPlanGeneration ?? 0,
    );
}

function seedTarget(sqlite: DatabaseSync, input: DispatchTargetSeed): void {
  const current = nowSec();
  const alertType = input.alertType ?? "dews";
  const jobId = `job:${input.sourceEventId}:${alertType}`;
  const targetKey = input.targetKey ?? `${input.chatId}:${alertType}:0`;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO telegram_alert_jobs (
       job_id, alert_type, source_event_id, severity, created_at, expires_at
     ) VALUES (?, ?, ?, 'normal', ?, ?)`,
    )
    .run(jobId, alertType, input.sourceEventId, current, current + 3_600);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_job_targets (
       job_id, target_key, chat_id, chunk_index, alert_type, status,
       pending_dedupe_key, created_at, source_event_id, plan_generation
     ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      targetKey,
      input.chatId,
      alertType,
      input.status ?? "planned",
      input.pendingDedupeKey ?? `pending:${targetKey}`,
      current,
      input.sourceEventId,
      input.planGeneration ?? 0,
    );
}

function dispatchOperationForSql(sql: string): DispatchOperation | null {
  if (sql.includes("pharos:telegram-dispatch:active-snoozes")) return "active-snoozes";
  if (
    sql.includes("pharos:telegram-dispatch:preset-subscribers") ||
    sql.includes("FROM telegram_preset_subscriptions p")
  ) {
    return "preset-subscribers";
  }
  if (sql.includes("FROM depeg_events event")) return "resolved-depeg-lookup";
  if (sql.includes("sub.alert_") || sql.includes("global_alert_")) return "subscriber-fanout";
  return null;
}

function withDispatchOperationFaults(
  db: D1Database,
  faults: DispatchOperationFault[],
  operations: DispatchOperationTranscriptEntry[],
): D1Database {
  const prepare = db.prepare.bind(db);
  const wrappedPrepare = (sql: string): D1PreparedStatement => {
    const statement = prepare(sql);
    const operation = dispatchOperationForSql(sql);
    if (!operation) return statement;
    const wrap = (bound: D1PreparedStatement, binds: unknown[] = []): D1PreparedStatement =>
      ({
        ...bound,
        bind: (...args: unknown[]) => wrap(bound.bind(...args), args),
        all: async <T>() => {
          operations.push({ operation, binds: [...binds] });
          const fault = faults.find((entry) => entry.operation === operation && (entry.remaining ?? 1) > 0);
          if (fault) {
            fault.remaining = (fault.remaining ?? 1) - 1;
            throw fault.error;
          }
          return bound.all<T>();
        },
        first: async <T>() => {
          operations.push({ operation, binds: [...binds] });
          const fault = faults.find((entry) => entry.operation === operation && (entry.remaining ?? 1) > 0);
          if (fault) {
            fault.remaining = (fault.remaining ?? 1) - 1;
            throw fault.error;
          }
          return bound.first<T>();
        },
      }) as D1PreparedStatement;
    return wrap(statement);
  };
  return { ...db, prepare: wrappedPrepare } as D1Database;
}

function seedDispatchFixture(sqlite: DatabaseSync, input: DispatchSeed): void {
  for (const [key, value] of Object.entries(input.cache ?? {})) seedCacheRow(sqlite, key, value);
  for (const row of input.subscribers ?? []) seedSubscriber(sqlite, row);
  for (const row of input.subscriptions ?? []) seedSubscription(sqlite, row);
  for (const row of input.presets ?? []) seedPreset(sqlite, row);
  for (const row of input.dews ?? []) seedDews(sqlite, row);
  for (const row of input.depegs ?? []) seedDepeg(sqlite, row);
  for (const row of input.safety ?? []) seedSafety(sqlite, row);
  for (const row of input.pending ?? []) seedPending(sqlite, row);
  for (const row of input.sourceEvents ?? []) seedSourceEvent(sqlite, row);
  for (const row of input.targets ?? []) seedTarget(sqlite, row);
}

function createDispatchHarness(faults: DispatchOperationFault[] = []): DispatchHarness {
  const { sqlite, db: sqliteDb } = createLatestSchemaSqlite();
  fixtureSqliteDatabases.push(sqlite);
  const operations: DispatchOperationTranscriptEntry[] = [];
  return {
    sqlite,
    db: withDispatchOperationFaults(sqliteDb, faults, operations),
    seed: (input) => seedDispatchFixture(sqlite, input),
    cache: (key, value, updatedAt) => seedCacheRow(sqlite, key, value, updatedAt),
    operations,
  };
}

function readCacheValue(sqlite: DatabaseSync, key: string): string | null {
  const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function recordPendingEnqueueAttempts(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE telegram_pending_enqueue_transcript (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      not_before_at INTEGER,
      expires_at INTEGER
    );
    CREATE TRIGGER record_telegram_pending_enqueue_attempt
    BEFORE INSERT ON telegram_pending_alerts
    BEGIN
      INSERT INTO telegram_pending_enqueue_transcript (dedupe_key, attempts, not_before_at, expires_at)
      VALUES (NEW.dedupe_key, NEW.attempts, NEW.not_before_at, NEW.expires_at);
    END;
  `);
}

function defaultDispatchCaches(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSec();
  return {
    "alert:dews-snapshot": {},
    "alert:depeg-snapshot": {},
    "alert:safety-snapshot": makeSafetySnapshotCache({}, getAlertSafetySourceGeneration()).value,
    "alert:safety-source-cache": makeSafetySourceCache({}, now - 60).value,
    ...overrides,
  };
}

export {
  STABLECOINS_CACHE_WITH_USDC,
  mockShouldAttemptFetch,
  mockRecordOutcome,
  mockInspectLegacyOverflowBacklog,
  mockSendToChat,
  mockSendBatch,
  telegramDeliveryTranscript,
  scriptTelegramDeliveries,
  scriptTelegramDeliveriesForChat,
  formatConsolidatedMessageSpy,
  dispatchTelegramAlerts,
  deliverTelegramSubscriberQueue,
  pruneOverflowPlanBacklogForChat,
  buildDedupeKey,
  emptyDrainResult,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
  makeSafetySourceCache,
  makeSafetySnapshotCache,
  makeDewsOverflowPlan,
  parseLogRecords,
  resetDispatchTelegramAlertsTest,
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness,
  defaultDispatchCaches,
  readCacheValue,
  recordPendingEnqueueAttempts,
  type CronProgressUpdate,
};
