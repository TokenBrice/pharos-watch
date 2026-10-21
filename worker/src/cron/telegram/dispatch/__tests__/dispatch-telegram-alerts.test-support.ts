import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { mockCircuitBreaker } from "../../../../test-helpers/cron";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../../../test-helpers/report-cards-v9";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { scoreToGrade } from "@shared/lib/report-card-core";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import { buildAlertSafetyV9SourceEnvelopeFromParts, ALERT_SAFETY_V9_SOURCE_GENERATION } from "../../../../lib/alert-safety-source-cache";
import type { CronProgressUpdate } from "../../../../lib/cron-logger";
import {
  insertPendingSqlite,
  makeTelegramDeliveryResult,
} from "../../delivery/__tests__/telegram-pending-queue.test-support";
import {
  insertTelegramSubscriber,
  type TelegramSubscriberSeed,
} from "./telegram-subscriber.test-support";

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
// The roll-up/freeze-batch hook has its own suites (rollup/__tests__); here it
// is a not-due no-op so dispatcher assertions cover live alerts only.
const mockRunTelegramRollupStep = vi.fn();
const fixtureSqliteDatabases: DatabaseSync[] = [];

function safetyScoreIdentity(publicationGenerationId: string) {
  return {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "9.0",
    policyId: "safety-score-v9",
    policyDigest: "a".repeat(64),
    evaluationBuildDigest: "b".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
    publicationGenerationId,
  };
}

vi.mock("../../rollup/rollup-step", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../rollup/rollup-step")>(),
  runTelegramRollupStep: mockRunTelegramRollupStep,
}));

vi.mock("../../../../lib/circuit-breaker", () =>
  mockCircuitBreaker({
    shouldAttemptFetchFn: mockShouldAttemptFetch,
    recordOutcomeFn: mockRecordOutcome,
  }),
);

const mockSendToChat = vi.fn();

export interface TelegramDeliveryResult {
  ok: boolean;
  blocked: boolean;
  retryable: boolean;
  permanentFailure: boolean;
  statusCode: number | null;
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

const DEFAULT_DELIVERY_RESULT: TelegramDeliveryResult = makeTelegramDeliveryResult();

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

vi.mock("../../../../telegram/delivery/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../telegram/delivery/telegram")>();
  return {
    ...actual,
    sendToChat: mockSendToChat,
  };
});

// Count `formatConsolidatedMessage` invocations while preserving behavior, so the
// C102 budget-before-format reorder can be asserted (format-count <= fresh budget
// + allowance, not once per candidate).
const formatConsolidatedMessageSpy = vi.fn();
vi.mock("../../../../telegram/common/alerts-formatting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../telegram/common/alerts-formatting")>();
  return {
    ...actual,
    formatConsolidatedMessage: (...args: Parameters<typeof actual.formatConsolidatedMessage>) => {
      formatConsolidatedMessageSpy(...args);
      return actual.formatConsolidatedMessage(...args);
    },
  };
});

const { dispatchTelegramAlerts } = await import("../dispatch-telegram-alerts");
const { TELEGRAM_MAX_MESSAGES_PER_RUN, TELEGRAM_FORMAT_BUDGET_ALLOWANCE } =
  await import("../../../../telegram/common/constants");

function makeCanonicalSafetySourceCaches(
  snapshot: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>,
  publishedAt: number,
) {
  const representativeScoreByGrade: Record<string, number | null> = {
    "A+": 90,
    A: 85,
    "A-": 81,
    "B+": 77,
    B: 72,
    "B-": 66,
    "C+": 62,
    C: 57,
    "C-": 52,
    D: 45,
    F: 20,
    NR: null,
  };
  const publicationGenerationId = `report-cards:v9:${publishedAt}`;
  const publication = makeWorkerSafetyScoreV9Publication({
    publicationGenerationId,
    publishedAtSec: publishedAt,
    asOfSec: publishedAt,
    cards: Object.entries(snapshot)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, row]) =>
        makeWorkerV9Card({
          id,
          grade: row.grade as ReturnType<typeof makeWorkerV9Card>["grade"],
          score:
            row.score !== null && scoreToGrade(row.score) === row.grade
              ? row.score
              : representativeScoreByGrade[row.grade] ?? row.score,
        }),
      ),
  });
  const publicationHealth = {
    schemaVersion: 2 as const,
    status: "current" as const,
    acceptedPublicationGenerationId: publicationGenerationId,
    acceptedAtSec: publishedAt,
    attemptedAtSec: publishedAt,
    heldSinceSec: null,
    reasons: [],
  };
  const sourceEnvelope = buildAlertSafetyV9SourceEnvelopeFromParts({
    cards: publication.cards,
    publishedAt,
    safetyScoreIdentity: safetyScoreIdentity(publicationGenerationId),
  });
  return {
    alertSafetySource: {
      value: stableJsonStringifyV1(sourceEnvelope),
      updatedAt: publishedAt,
    },
    publication: {
      value: stableJsonStringifyV1(publication),
      updatedAt: publishedAt,
    },
    publicationHealth: {
      value: stableJsonStringifyV1(publicationHealth),
      updatedAt: publishedAt,
    },
  };
}

function seedActiveSafetySource(
  harness: Pick<DispatchHarness, "cache">,
  snapshot: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>,
  publishedAt: number,
): void {
  const caches = makeCanonicalSafetySourceCaches(snapshot, publishedAt);
  harness.cache(
    "report-cards:v9",
    caches.publication.value,
    caches.publication.updatedAt,
  );
  harness.cache(
    "report-cards:v9:publication-health",
    caches.publicationHealth.value,
    caches.publicationHealth.updatedAt,
  );
  harness.cache("alert-safety-v9-source", caches.alertSafetySource.value, caches.alertSafetySource.updatedAt);
}

type SafetyBaselineSeedRow = {
  grade: string;
  score: number | null;
  methodologyVersion: string | null;
  pendingKind?: "severe-downgrade" | "upgrade";
  pendingSinceSec?: number;
  lastAlertedAtSec?: number;
};

/**
 * Baseline rows are seeded as if a severe downgrade had already held for the
 * full live-alert dwell, so a seeded grade drop alerts on this run. Tests that
 * exercise the dwell itself override `pendingSinceSec`/`pendingKind`.
 */
function makeSafetySnapshotCache(
  snapshot: Record<string, SafetyBaselineSeedRow>,
  generation = ALERT_SAFETY_V9_SOURCE_GENERATION,
) {
  return {
    value: JSON.stringify({
      generation,
      safetyScoreIdentity: safetyScoreIdentity("report-cards:v9:baseline"),
      snapshot: Object.fromEntries(
        Object.entries(snapshot).map(([id, row]) => [
          id,
          {
            pendingKind: "severe-downgrade",
            pendingSinceSec: nowSec() - TELEGRAM_ALERT_POLICY.safety.dwellSec,
            ...row,
            methodologyVersion: "9.0",
            ratingStatus: row.grade === "NR" ? "not-rated" : "rated",
            partialEvidence: null,
            v9Explain: {
              reasons: [],
              bindingCap: null,
              weakestPillar:
                row.score === null
                  ? null
                  : { pillar: "backing", score: row.score },
              pillars: {
                backing: {
                  score: row.score,
                  evidenceLevel: "adequate",
                  freshness: "current",
                },
                exit: {
                  score: row.score,
                  evidenceLevel: "adequate",
                  freshness: "current",
                },
                control: {
                  score: row.score,
                  evidenceLevel: "adequate",
                  freshness: "current",
                },
              },
            },
          },
        ]),
      ),
    }),
    updatedAt: Math.floor(Date.now() / 1000) - 60,
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
  mockRunTelegramRollupStep.mockReset();
  mockRunTelegramRollupStep.mockResolvedValue({
    freezeBatch: { state: "not-due", changes: 0, chats: 0 },
    rollup: { state: "not-due", dueChats: 0, sentChats: 0, emptyChats: 0, deferredChats: 0 },
  });
  mockSendToChat.mockReset();
  telegramDeliveryTranscript.length = 0;
  scriptedDeliveryResults = [];
  scriptedDeliveryResultsByChat.clear();

  mockShouldAttemptFetch.mockResolvedValue(true);
  mockRecordOutcome.mockResolvedValue(undefined);
  mockSendToChat.mockImplementation(async (chatId, html, botToken, options) =>
    recordDisabledTelegramDelivery(chatId, html, botToken, options ?? {}),
  );
}

function cleanupDispatchTelegramAlertsTest() {
  vi.useRealTimers();
  while (fixtureSqliteDatabases.length > 0) fixtureSqliteDatabases.pop()?.close();
}

type AlertFamilySeed = "dews" | "depeg" | "safety" | "launch" | "reserve";

type AlertFlags = Partial<Record<AlertFamilySeed, boolean>>;

export type DispatchSubscriberSeed = TelegramSubscriberSeed;

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
  /**
   * By default a seeded row is the second DEWS computation of its band, so an
   * escalation alerts on this run. True seeds it as the first sighting.
   */
  firstComputation?: boolean;
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

function seedSubscriptions(sqlite: DatabaseSync, inputs: DispatchSubscriptionSeed[]): void {
  if (inputs.length === 0) return;
  const statement = sqlite.prepare(
      `INSERT INTO telegram_subscriptions (
       chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety,
       alert_launch, alert_reserve, dews_min_band, safety_mode,
       depeg_worsening_bps_step, alert_snooze_until_ts, alert_dews_override,
       alert_depeg_override, alert_safety_override, alert_launch_override,
       alert_reserve_override
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  for (const input of inputs) statement.run(
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

const DEWS_CANDIDATE_SNAPSHOT_KEY = "alert:dews-candidate-snapshot";

function seedDews(sqlite: DatabaseSync, input: DispatchDewsSeed): void {
  const computedAt = input.computedAt ?? nowSec();
  if (input.firstComputation !== true) {
    const existing = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(DEWS_CANDIDATE_SNAPSHOT_KEY) as
      { value: string } | undefined;
    const candidates = existing ? JSON.parse(existing.value) as Record<string, unknown> : {};
    candidates[input.stablecoinId] = { computedAt: computedAt - 1800, computations: 1 };
    seedCacheRow(sqlite, DEWS_CANDIDATE_SNAPSHOT_KEY, candidates);
  }
  sqlite
    .prepare(
      "INSERT INTO stress_signals (stablecoin_id, computed_at, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      input.stablecoinId,
      computedAt,
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
  insertPendingSqlite(sqlite, {
    ...input,
    sourceType: input.sourceType ?? "risk_alert",
  });
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
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrappedPrepare = (sql: string): D1PreparedStatement => {
    const statement = prepare(sql);
    const operation = dispatchOperationForSql(sql);
    if (!operation) return statement;
    const wrap = (bound: D1PreparedStatement, binds: unknown[] = []): D1PreparedStatement => {
      const wrapped = {
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
      } as D1PreparedStatement;
      originals.set(wrapped, bound);
      return wrapped;
    };
    return wrap(statement);
  };
  return {
    ...db,
    prepare: wrappedPrepare,
    batch: <T = unknown>(statements: D1PreparedStatement[]) =>
      db.batch<T>(statements.map((statement) => originals.get(statement) ?? statement)),
  } as D1Database;
}

function seedDispatchFixture(sqlite: DatabaseSync, input: DispatchSeed): void {
  for (const [key, value] of Object.entries(input.cache ?? {})) seedCacheRow(sqlite, key, value);
  for (const row of input.subscribers ?? []) insertTelegramSubscriber(sqlite, row);
  seedSubscriptions(sqlite, input.subscriptions ?? []);
  for (const row of input.presets ?? []) seedPreset(sqlite, row);
  for (const row of input.dews ?? []) seedDews(sqlite, row);
  for (const row of input.depegs ?? []) seedDepeg(sqlite, row);
  for (const row of input.safety ?? []) seedSafety(sqlite, row);
  for (const row of input.pending ?? []) seedPending(sqlite, row);
  for (const row of input.sourceEvents ?? []) seedSourceEvent(sqlite, row);
  for (const row of input.targets ?? []) seedTarget(sqlite, row);
}

function createDispatchHarness(
  faults: DispatchOperationFault[] = [],
): DispatchHarness {
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

function defaultDispatchCaches(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSec();
  const safety = makeCanonicalSafetySourceCaches({}, now - 60);
  return {
    "alert:dews-snapshot": {},
    "alert:depeg-snapshot": {},
    "alert:safety-snapshot": makeSafetySnapshotCache({}, ALERT_SAFETY_V9_SOURCE_GENERATION).value,
    "report-cards:v9": safety.publication.value,
    "report-cards:v9:publication-health": safety.publicationHealth.value,
    "alert-safety-v9-source": safety.alertSafetySource.value,
    ...overrides,
  };
}

export {
  mockRunTelegramRollupStep,
  STABLECOINS_CACHE_WITH_USDC,
  mockShouldAttemptFetch,
  mockRecordOutcome,
  mockSendToChat,
  telegramDeliveryTranscript,
  scriptTelegramDeliveries,
  scriptTelegramDeliveriesForChat,
  formatConsolidatedMessageSpy,
  dispatchTelegramAlerts,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  seedActiveSafetySource,
  makeSafetySnapshotCache,
  parseLogRecords,
  resetDispatchTelegramAlertsTest,
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness,
  defaultDispatchCaches,
  readCacheValue,
  type CronProgressUpdate,
};
