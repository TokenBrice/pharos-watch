import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_SAFETY_V9_SOURCE_GENERATION,
  assessAlertSafetyEnvelope,
  buildAlertSafetyV9SourceEnvelopeFromParts,
} from "../../../../lib/alert-safety-source-cache";
import { makeWorkerReportCardsV9Response } from "../../../../test-helpers/report-cards-v9";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../../../lib/safety-score-v9/consumer-freshness";
import type * as DbCache from "../../../../lib/db-cache";
import { deliverOperatorAlert } from "../../../cron-sentinel-rules";
import { recordOperatorAlertReceipt } from "../../../../lib/status/operator-alert-health";
import { escapeHtml } from "../../../../telegram/common/html";

vi.mock("../../../cron-sentinel-rules", () => ({ deliverOperatorAlert: mockDeliverOperatorAlert }));
vi.mock("../../../../lib/status/operator-alert-health", () => ({ recordOperatorAlertReceipt: vi.fn() }));

const fixtures = createLatestSchemaFixtureTracker();
const operatorTelegramCreds = { botToken: "bot", chatId: "operator" };

const {
  mockDeliverOperatorAlert,
  mockGetCache,
  mockSetCache,
  mockDeleteCache,
  mockLoadActiveAlertSafetySourceAssessment,
} = vi.hoisted(() => ({
  mockDeliverOperatorAlert: vi.fn(),
  mockGetCache: vi.fn(),
  mockSetCache: vi.fn(),
  mockDeleteCache: vi.fn(),
  mockLoadActiveAlertSafetySourceAssessment: vi.fn(),
}));

vi.mock("../../../../lib/db-cache", () => ({
  getCache: mockGetCache,
  setCache: mockSetCache,
  deleteCache: mockDeleteCache,
}));

vi.mock("../../../../lib/alert-safety-source-cache", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../lib/alert-safety-source-cache")
  >();
  return {
    ...actual,
    loadActiveAlertSafetySourceAssessment:
      mockLoadActiveAlertSafetySourceAssessment,
  };
});

const {
  runTelegramDegradationWatchdog,
  PENDING_BACKLOG_THRESHOLD,
  PENDING_BACKLOG_SUSTAINED_SEC,
  ZERO_SEND_STREAK_THRESHOLD,
  WATCHDOG_KEYS,
  DELIVERY_ALERT_COOLDOWN_SEC,
} = await import("../telegram-degradation-watchdog");

function safetyDiagnostics(assessedAtSec = Math.floor(Date.now() / 1000)) {
  return {
    sourcePublicationGenerationId: "accepted-generation",
    acceptedPublicationGenerationId: "accepted-generation",
    freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
    assessedAtSec,
  };
}

interface CacheStore {
  values: Map<string, { value: string; updatedAt: number }>;
}

function seedOnset(store: CacheStore, key: string, since: number) {
  store.values.set(key, { value: String(since), updatedAt: since });
}

function installCacheStore(): CacheStore {
  const store: CacheStore = { values: new Map() };
  mockGetCache.mockImplementation(async (_db: unknown, key: string) => store.values.get(key) ?? null);
  mockSetCache.mockImplementation(async (_db: unknown, key: string, value: string) => {
    store.values.set(key, { value, updatedAt: Math.floor(Date.now() / 1000) });
  });
  mockDeleteCache.mockImplementation(async (_db: unknown, key: string) => { store.values.delete(key); });
  return store;
}

interface FakeDbConfig {
  pendingCount?: number;
  oldestPendingAgeSec?: number | null;
  nearTtl?: number;
  sending?: number;
  pendingExecutionUnknown?: number;
  freshExecutionUnknown?: number;
  oldestExecutionUnknownAgeSec?: number | null;
  capacityError?: boolean;
  dispatchRunId?: number;
  dispatchMetadata?: Record<string, unknown> | null;
}

const PENDING_CAPACITY_TOTAL_SQL = "SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS total";

function isPendingCapacityQuery(sql: string): boolean {
  return sql.includes("FROM telegram_deliveries") && sql.includes(PENDING_CAPACITY_TOTAL_SQL);
}

function makePendingCapacityRow(config: FakeDbConfig = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const pendingCount = config.pendingCount ?? 0;
  const oldestPendingAgeSec = config.oldestPendingAgeSec ?? (pendingCount > 0 ? 60 : null);
  return {
    total: pendingCount,
    expired: 0,
    due: pendingCount,
    deferred: 0,
    near_ttl: config.nearTtl ?? 0,
    oldest_pending_created_at: oldestPendingAgeSec == null ? null : nowSec - oldestPendingAgeSec,
    oldest_due_created_at: oldestPendingAgeSec == null ? null : nowSec - oldestPendingAgeSec,
    pending_sending: config.sending ?? 0,
    pending_execution_unknown: config.pendingExecutionUnknown ?? 0,
    sent_cleanup: 0,
    oldest_pending_execution_unknown_at:
      config.oldestExecutionUnknownAgeSec == null ? null : nowSec - config.oldestExecutionUnknownAgeSec,
    fresh_sending: 0,
    fresh_execution_unknown: config.freshExecutionUnknown ?? 0,
    oldest_fresh_execution_unknown_at: null,
    fresh_uncertain_sample_count: config.freshExecutionUnknown ?? 0,
  };
}

function makeDb(config: FakeDbConfig = {}): D1Database {
  const prepare = vi.fn((sql: string) => {
    const bind = vi.fn(() => statement);
    const first = vi.fn(async () => {
      if (isPendingCapacityQuery(sql)) {
        if (config.capacityError) throw new Error("capacity unavailable");
        return makePendingCapacityRow(config);
      }
      if (sql.includes("FROM cron_runs WHERE job = 'dispatch-telegram-alerts'")) {
        return config.dispatchMetadata ? { id: config.dispatchRunId ?? 1, metadata: JSON.stringify(config.dispatchMetadata) } : null;
      }
      return null;
    });
    const statement = { bind, first } as unknown as D1PreparedStatement;
    return statement;
  });
  return { prepare } as unknown as D1Database;
}

async function useRealCache() {
  const cache = await vi.importActual<typeof DbCache>("../../../../lib/db-cache");
  mockGetCache.mockImplementation(cache.getCache);
  mockSetCache.mockImplementation(cache.setCache);
  mockDeleteCache.mockImplementation(cache.deleteCache);
}

async function evaluate(db: D1Database) {
  const result = await runTelegramDegradationWatchdog(db);
  return { result, meta: JSON.parse(result.metadata ?? "{}") };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
  mockGetCache.mockReset();
  mockSetCache.mockReset();
  mockDeleteCache.mockReset();
  mockLoadActiveAlertSafetySourceAssessment.mockReset();
  mockDeliverOperatorAlert.mockReset().mockResolvedValue({ ok: true });
  vi.mocked(recordOperatorAlertReceipt).mockClear();
  mockLoadActiveAlertSafetySourceAssessment.mockResolvedValue({
    ...safetyDiagnostics(),
    state: "ok",
    ageSeconds: 60,
    generation: ALERT_SAFETY_V9_SOURCE_GENERATION,
    envelope: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  fixtures.closeAll();
});

describe("runTelegramDegradationWatchdog · pending backlog", () => {
  it("preserves an active incident when capacity is unavailable", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    seedOnset(store, WATCHDOG_KEYS.pendingSince, nowSec - 3600);

    const { result, meta } = await evaluate(makeDb({ capacityError: true }));

    expect(result.status).toBe("degraded");
    expect(meta.pendingBacklog.availability).toBe("unknown");
    expect(meta.pendingBacklog.detail).toContain("incident state preserved");
    expect(store.values.has(WATCHDOG_KEYS.pendingSince)).toBe(true);
    expect(recordOperatorAlertReceipt).toHaveBeenLastCalledWith(expect.anything(), "telegramDelivery",
      expect.objectContaining({ pending: false, delivered: false, reason: "pending-backlog-unavailable" }), undefined);
  });

  it("records an onset without triggering on first observation above threshold", async () => {
    const store = installCacheStore();
    const db = makeDb({ pendingCount: PENDING_BACKLOG_THRESHOLD + 5 });

    const { result, meta } = await evaluate(db);

    expect(meta.pendingBacklog.triggered).toBe(false);
    expect(meta.pendingBacklog.detail).toContain("newly tripped");
    expect(result.status).toBe("ok");
    expect(store.values.has(WATCHDOG_KEYS.pendingSince)).toBe(true);
    expect(recordOperatorAlertReceipt).toHaveBeenLastCalledWith(db, "telegramDelivery",
      expect.objectContaining({ pending: false, delivered: false, reason: null }), undefined);
  });

  it("clears the episode when backlog drains", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    seedOnset(store, WATCHDOG_KEYS.pendingSince, nowSec - 3600);
    const db = makeDb({ pendingCount: 10 });

    const { meta } = await evaluate(db);

    expect(meta.pendingBacklog.recovered).toBe(true);
    expect(store.values.has(WATCHDOG_KEYS.pendingSince)).toBe(false);
  });

  it.each([
    { name: "treats aged execution-unknown work as delivery risk", config: { pendingExecutionUnknown: 1, oldestExecutionUnknownAgeSec: 1800 }, detail: "executionUnknown=1", fields: { executionUnknown: 1 } },
    { name: "triggers once threshold has been sustained beyond window", config: { pendingCount: PENDING_BACKLOG_THRESHOLD + 50 }, detail: "pending=", fields: {} },
    { name: "triggers on old pending age even when queue size is below the count threshold", config: { pendingCount: 10, oldestPendingAgeSec: 1200 }, detail: "oldestAgeSec=", fields: { oldestAgeSec: 1200 } },
    { name: "triggers on estimated drain time over the threshold", config: { pendingCount: 10_801 }, detail: "estimatedDrainTimeSec=", fields: { estimatedDrainTimeSec: 2100 } },
  ])("$name", async ({ config, detail, fields }) => {
    const store = installCacheStore();
    const since = Math.floor(Date.now() / 1000) - PENDING_BACKLOG_SUSTAINED_SEC - 30;
    seedOnset(store, WATCHDOG_KEYS.pendingSince, since);
    const { result, meta } = await evaluate(makeDb(config));
    expect(meta.pendingBacklog).toMatchObject({ triggered: true, ...fields });
    expect(meta.pendingBacklog.detail).toContain(detail);
    expect(result.status).toBe("degraded");
    expect(meta.reason).toBe("operator-alert-credentials-missing");
    expect(recordOperatorAlertReceipt).toHaveBeenLastCalledWith(expect.anything(), "telegramDelivery",
      expect.objectContaining({ operatorConfigured: false, pending: true, delivered: false, reason: meta.reason }), undefined);
  });

  it("triggers near-TTL escalation after onset, including one created this run", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    const onsetResult = await runTelegramDegradationWatchdog(makeDb({ pendingCount: 3, nearTtl: 1 }));
    const onsetMeta = JSON.parse(onsetResult.metadata ?? "{}");

    expect(onsetMeta.pendingBacklog.triggered).toBe(false);
    expect(onsetMeta.pendingBacklog.detail).toContain("newly tripped");
    expect(onsetResult.status).toBe("ok");
    expect(store.values.get(WATCHDOG_KEYS.pendingSince)?.value).toBe(String(nowSec));
    const db = makeDb({ pendingCount: 3, nearTtl: 1 });

    const { result, meta } = await evaluate(db);

    expect(meta.pendingBacklog.triggered).toBe(true);
    expect(meta.pendingBacklog.detail).toContain("nearTtl=1");
    expect(meta.pendingBacklog.nearTtl).toBe(1);
    expect(result.status).toBe("degraded");
  });
});

describe("runTelegramDegradationWatchdog · safety source", () => {
  it.each([
    { name: "includes held-publication diagnostics after the sustained window", codes: ["dex-stale", "coverage-floor-failed"] },
    { name: "preserves an already-flagged held episode without rewriting its onset", codes: ["dex-stale"] },
  ])("$name", async ({ codes }) => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    mockLoadActiveAlertSafetySourceAssessment.mockResolvedValue({
      ...safetyDiagnostics(), state: "corrupt", ageSeconds: null, generation: null,
      envelope: null, failureReason: "v9-publication-held",
      heldSinceSec: nowSec - 7200, holdReasonCodes: codes,
    });
    seedOnset(store, WATCHDOG_KEYS.safetySourceSince, nowSec - 8000);
    const db = makeDb();
    const first = await runTelegramDegradationWatchdog(db, undefined, { operatorTelegramCreds });
    const meta = JSON.parse(first.metadata!);
    expect(meta.safetySource).toMatchObject({
      triggered: true, heldSinceSec: nowSec - 7200, holdAgeSec: 7200, holdReasonCodes: codes,
    });
    expect(meta.safetySource.detail).toBe(
      `state=corrupt, sustainedSec=8000, heldSinceSec=${nowSec - 7200}, holdAgeSec=7200, holdReasonCodes=${codes.join("|")}`,
    );
    mockSetCache.mockClear();
    const second = await runTelegramDegradationWatchdog(db, undefined, { operatorTelegramCreds });
    expect(JSON.parse(second.metadata!).safetySource).toMatchObject({ triggered: true, detail: meta.safetySource.detail });
    expect(store.values.get(WATCHDOG_KEYS.safetySourceSince)?.value).toBe(String(nowSec - 8000));
    expect(mockSetCache.mock.calls.some(([, key]) => key === WATCHDOG_KEYS.safetySourceSince)).toBe(false);
    expect(deliverOperatorAlert).not.toHaveBeenCalled();
  });

  it("opens a safety-source episode for a future-dated accepted clock instead of reading it as ok", async () => {
    installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    const response = makeWorkerReportCardsV9Response({ updatedAt: nowSec + 600 });
    const envelope = buildAlertSafetyV9SourceEnvelopeFromParts({
      cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt,
    });
    const result = await runTelegramDegradationWatchdog(makeDb(), undefined, {
      safetySourceAssessment: assessAlertSafetyEnvelope(envelope, nowSec),
    });
    expect(JSON.parse(result.metadata ?? "{}").safetySource).toMatchObject({
      state: "corrupt", failureReason: "v9-snapshot-future", ageSeconds: null,
      triggered: false, detail: "state=corrupt (newly tripped)",
    });
  });

  it.each([
    ["triggers when safety-source cache is missing for sustained window", 8000],
    ["does not trigger until sustained window elapses", 60],
  ])("%s", async (_name, age) => {
    const store = installCacheStore();
    const since = Math.floor(Date.now() / 1000) - age;
    mockLoadActiveAlertSafetySourceAssessment.mockResolvedValue({
      ...safetyDiagnostics(), state: "missing", ageSeconds: null, generation: null,
      envelope: null, failureReason: "v9-snapshot-unavailable",
    });
    const cached = { value: String(since), updatedAt: since };
    store.values.set(WATCHDOG_KEYS.safetySourceSince, cached);
    const db = makeDb();
    const { meta } = await evaluate(db);
    expect(meta.safetySource.triggered).toBe(age === 8000);
    expect(meta.safetySource.detail).toContain("state=missing");
    expect(store.values.get(WATCHDOG_KEYS.safetySourceSince)).toEqual(cached);
    expect(mockSetCache.mock.calls.some(([, key]) => key === WATCHDOG_KEYS.safetySourceSince)).toBe(false);
    if (age === 60) {
      vi.advanceTimersByTime((2 * CRON_INTERVALS["compute-safety-score-v9"] - age) * 1000);
      const sustained = await runTelegramDegradationWatchdog(db);
      expect(JSON.parse(sustained.metadata ?? "{}").safetySource.triggered).toBe(true);
    }
  });

  it("recovers when state returns to ok after sustained breach", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    seedOnset(store, WATCHDOG_KEYS.safetySourceSince, nowSec - 8000);
    const db = makeDb();

    const { meta } = await evaluate(db);

    expect(meta.safetySource.recovered).toBe(true);
    expect(store.values.has(WATCHDOG_KEYS.safetySourceSince)).toBe(false);
    expect(mockDeleteCache).toHaveBeenCalledWith(
      expect.anything(),
      WATCHDOG_KEYS.safetySourceSince,
    );
  });

  it.each(["newly-tripped", "sustained", "pending-masked", "recovered"] as const)("retains preloaded source provenance on %s outcomes", async (phase) => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    const assessment = {
      ...safetyDiagnostics(nowSec - 300),
      state: phase === "recovered" ? "ok" as const : "corrupt" as const,
      ageSeconds: 1_200,
      generation: ALERT_SAFETY_V9_SOURCE_GENERATION,
      sourcePublicationGenerationId: "source-generation",
      acceptedPublicationGenerationId: "accepted-generation",
      envelope: null,
      ...(phase === "recovered" ? {} : { failureReason: "v9-snapshot-invalid" }),
    };
    if (phase !== "newly-tripped") seedOnset(store, WATCHDOG_KEYS.safetySourceSince, nowSec - 8_000);
    if (phase === "pending-masked") seedOnset(store, WATCHDOG_KEYS.pendingSince, nowSec - 8_000);
    const result = await runTelegramDegradationWatchdog(makeDb({ pendingCount: phase === "pending-masked" ? PENDING_BACKLOG_THRESHOLD + 1 : 0 }), undefined, { safetySourceAssessment: assessment });
    const meta = JSON.parse(result.metadata ?? "{}");
    expect(meta.safetySource).toMatchObject({
      state: assessment.state, ageSeconds: 1_200, generation: assessment.generation,
      sourcePublicationGenerationId: "source-generation", acceptedPublicationGenerationId: "accepted-generation",
      freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC, assessedAtSec: nowSec - 300,
      failureReason: phase === "recovered" ? null : "v9-snapshot-invalid",
      triggered: phase === "sustained" || phase === "pending-masked",
      recovered: phase === "recovered",
    });
    expect(mockLoadActiveAlertSafetySourceAssessment).not.toHaveBeenCalled();
    if (phase === "newly-tripped") expect(meta.safetySource.detail).toBe("state=corrupt (newly tripped)");
    if (phase === "pending-masked") {
      expect(meta.pendingBacklog.triggered).toBe(true);
      expect(result.metadata).toContain("v9-snapshot-invalid");
    }
    if (phase === "recovered") expect(store.values.has(WATCHDOG_KEYS.safetySourceSince)).toBe(false);
    else expect(store.values.get(WATCHDOG_KEYS.safetySourceSince)?.value).toBe(String(nowSec - (phase === "newly-tripped" ? 0 : 8_000)));
  });
});

function dispatchWork(events: Record<string, number> = { dews: 1 }, messagesSent = 0, plannedTargetCount = 1, sourceEventId: string | null = "source-1", sourceEventFamilies = Object.keys(events)) {
  return {
    eventsDetected: { dews: 0, depeg: 0, safety: 0, launch: 0, ...events }, messagesSent,
    authoritativePlanning: { sourceEventId, sourceEventFamilies, plannedTargetCount },
  };
}

describe("runTelegramDegradationWatchdog · zero-send streak", () => {
  it.each([
    { reason: "read-failed", streak: 0, metadata: null },
    { reason: "read-failed", metadata: null },
    { reason: "missing-metadata", metadata: null },
    { reason: "invalid-json", metadata: "{" },
    { reason: "invalid-shape", metadata: "[]" },
    { reason: "malformed-count", metadata: '{"eventsDetected":{"dews":"bad"}}' },
    { reason: "missing-count", metadata: '{"eventsDetected":{"dews":0}}' },
    {
      reason: "missing-planned-target-count",
      metadata: JSON.stringify({ ...dispatchWork(), authoritativePlanning: undefined }),
    },
    {
      reason: "missing-freeze-target-count",
      metadata: JSON.stringify({ ...dispatchWork({ freeze: 1 }), authoritativePlanning: undefined }),
    },
    {
      reason: "missing-planned-target-count",
      metadata: JSON.stringify({ ...dispatchWork(), authoritativePlanning: undefined, freshCandidateChats: 0 }),
    },
    {
      reason: "source-workload-not-applicable",
      metadata: JSON.stringify(dispatchWork(undefined, 0, 0, "another-family", ["reserve"])),
    },
    {
      reason: "source-workload-not-applicable",
      metadata: JSON.stringify(dispatchWork(undefined, 0, 0, null)),
    },
    {
      reason: "missing-planned-target-count",
      metadata: JSON.stringify(dispatchWork(undefined, 0, -1, "source-18")),
    },
    {
      reason: "planning-incomplete",
      metadata: JSON.stringify({
        eventsDetected: {
          dews: 0, depeg: 0, depegTriggered: 0, depegResolved: 0, depegWorsening: 0,
          safety: 0, launch: 0, reserve: 0, freeze: 0, suppressedMethodologyChanges: 0,
        },
        messagesSent: 0,
        freezeTargetCount: 0,
        authoritativePlanning: { sourceEventId: null, sourceEventFamilies: [], plannedTargetCount: 0 },
        reason: "telegram-planning-failed",
        reasons: ["telegram-planning-failed"],
        deliveryV2: { planningErrors: ["alert-detection:d1"] },
      }),
    },
  ].map((row) => ({ streak: 3, ...row })))("preserves durable episode state for $reason at streak $streak", async ({ reason, streak, metadata }) => {
    await useRealCache();
    const { sqlite, db: baseDb } = fixtures.open();
    const nowSec = Math.floor(Date.now() / 1000);
    const state = JSON.stringify({ streak, lastRunIdentity: "17" });
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(WATCHDOG_KEYS.zeroSendStreak, state, nowSec - 60);
    sqlite.prepare("INSERT INTO cron_runs (id, job, started_at, duration_ms, status, metadata) VALUES (18, 'dispatch-telegram-alerts', ?, 0, ?, ?)")
      .run(nowSec, reason === "planning-incomplete" ? "degraded" : "ok", metadata);
    const db = {
      ...baseDb,
      prepare(sql: string) {
        if (reason === "read-failed" && sql.includes("FROM cron_runs WHERE job = 'dispatch-telegram-alerts'")) {
          throw new Error("dispatch ledger unavailable");
        }
        return baseDb.prepare(sql);
      },
    };

    const { result, meta } = await evaluate(db);

    expect(result.status).toBe("degraded");
    expect(meta.reason).toBe("dispatch-evidence-unavailable");
    expect(meta.pendingBacklog.availability).toBe("available");
    expect(meta.zeroSend).toMatchObject({
      availability: "unknown", reason, streak, triggered: streak === 3,
      recovered: false, evaluated: false, runIdentity: reason === "read-failed" ? null : "18",
    });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
      .get(WATCHDOG_KEYS.zeroSendStreak)).toEqual({ value: state, updated_at: nowSec - 60 });
  });

  it.each([0, 3])("distinguishes an empty dispatch ledger from failed evidence at streak %s", async (streak) => {
    const store = installCacheStore();
    const state = { value: JSON.stringify({ streak, lastRunIdentity: "17" }), updatedAt: 1 };
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, state);
    const { result, meta } = await evaluate(makeDb());

    expect(result.status).toBe(streak === 3 ? "degraded" : "ok");
    expect(meta.zeroSend).toMatchObject({
      availability: "available", reason: "no-completed-run", streak,
      triggered: streak === 3, recovered: false, evaluated: false, runIdentity: null,
    });
    expect(store.values.get(WATCHDOG_KEYS.zeroSendStreak)).toEqual(state);
  });

  it.each([0, 2])("does not increment the same dispatch cron run twice (prior streak %s)", async (priorStreak) => {
    const store = installCacheStore();
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, {
      value: JSON.stringify({ streak: priorStreak, lastRunIdentity: "76" }), updatedAt: 1,
    });
    const db = makeDb({ dispatchRunId: 77, dispatchMetadata: dispatchWork() });

    await runTelegramDegradationWatchdog(db);
    const second = await runTelegramDegradationWatchdog(db);
    const meta = JSON.parse(second.metadata ?? "{}");
    const state = JSON.parse(store.values.get(WATCHDOG_KEYS.zeroSendStreak)?.value ?? "{}");

    expect(state).toEqual({ streak: priorStreak + 1, lastRunIdentity: "77" });
    expect(meta.zeroSend.streak).toBe(priorStreak + 1);
    expect(meta.zeroSend).toMatchObject({
      availability: "available", reason: "already-evaluated", triggered: priorStreak === 2, recovered: false,
    });
    expect(second.status).toBe(priorStreak === 2 ? "degraded" : "ok");
    expect(meta.zeroSend.evaluated).toBe(false);
    expect(meta.zeroSend.runIdentity).toBe("77");
  });

  it.each([
    ["does not trigger before reaching streak threshold", 0, { dews: 1 }],
    ["increments the streak for a reserve-only zero-send run", 0, { reserve: 2 }],
    ["triggers after threshold consecutive zero-send runs", 2, { dews: 2, depeg: 1 }],
    ["stays triggered while the zero-send streak continues", 3, { dews: 2, depeg: 1 }],
  ] as const)("%s", async (_name, prior, events) => {
    const store = installCacheStore();
    if (prior) store.values.set(WATCHDOG_KEYS.zeroSendStreak, { value: String(prior), updatedAt: 1 });
    const { result, meta } = await evaluate(makeDb({ dispatchMetadata: dispatchWork(events) }));
    expect(meta.zeroSend).toMatchObject({ triggered: prior + 1 >= ZERO_SEND_STREAK_THRESHOLD, streak: prior + 1 });
    expect(result.status).toBe(prior + 1 >= ZERO_SEND_STREAK_THRESHOLD ? "degraded" : "ok");
  });

  it.each([
    ["recovers and resets streak when dispatch sends again", 1, 7, 3, true],
    ["recovers when the evaluated source has an observed zero-target workload", 18, 0, 0, false],
  ] as const)("%s", async (_name, id, messages, targets, legacy) => {
    const store = installCacheStore();
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, {
      value: legacy ? String(ZERO_SEND_STREAK_THRESHOLD) : JSON.stringify({ streak: ZERO_SEND_STREAK_THRESHOLD, lastRunIdentity: "17" }), updatedAt: 1,
    });
    const db = makeDb({ dispatchRunId: id, dispatchMetadata: dispatchWork({ dews: legacy ? 1 : 2 }, messages, targets) });
    const { meta } = await evaluate(db);
    expect(meta.zeroSend).toMatchObject({ availability: "available", recovered: true, evaluated: true, triggered: false, streak: 0 });
    expect(JSON.parse(store.values.get(WATCHDOG_KEYS.zeroSendStreak)?.value ?? "{}"))
      .toEqual({ streak: 0, lastRunIdentity: String(id) });
    const repeated = await runTelegramDegradationWatchdog(db);
    expect(JSON.parse(repeated.metadata ?? "{}").zeroSend).toMatchObject({
      availability: "available", reason: "already-evaluated", evaluated: false, recovered: false, triggered: false,
    });
  });

  it.each([false, true])("ignores runs with no events even if messagesSent is zero (bootstrap %s)", async (snapshotSeeded) => {
    installCacheStore();
    const db = makeDb({
      dispatchMetadata: {
        snapshotSeeded,
        eventsDetected: { dews: 0, depeg: 0, safety: 0, launch: 0 },
        messagesSent: 0,
      },
    });

    const { result, meta } = await evaluate(db);

    expect(meta.zeroSend.triggered).toBe(false);
    expect(meta.zeroSend.streak).toBe(0);
    expect(meta.zeroSend).toMatchObject({ availability: "available", reason: null, evaluated: true });
    expect(result.status).toBe("ok");
  });

});

describe("delivery notifications", () => {
  it("raises only on the third distinct dispatch and remains silent after acknowledgement", async () => {
    installCacheStore();
    for (const id of [1, 1, 2, 3, 3]) {
      await runTelegramDegradationWatchdog(makeDb({ dispatchRunId: id, dispatchMetadata: dispatchWork() }), undefined, { operatorTelegramCreds });
      expect(mockDeliverOperatorAlert).toHaveBeenCalledTimes(id === 3 ? 1 : 0);
    }
  });

  it.each(["{", '{"version":3}'])("holds invalid notification state %s without sending or overwriting it", async (value) => {
    const store = installCacheStore();
    store.values.set(WATCHDOG_KEYS.notifications, { value, updatedAt: 1 });
    await expect(runTelegramDegradationWatchdog(makeDb())).rejects.toThrow("notification state invalid");
    expect(mockSetCache).not.toHaveBeenCalled();
    expect(deliverOperatorAlert).not.toHaveBeenCalled();
    expect(recordOperatorAlertReceipt).not.toHaveBeenCalled();
  });

  it.each(["raise", "recovery", "batched", "write-failed"])("replays failed %s history through unknown evidence and a later breach", async (phase) => {
    await useRealCache();
    const { sqlite, db } = fixtures.open();
    const signal = new AbortController().signal;
    const firstAccepted = phase === "recovery" || phase === "write-failed";
    const run = () => runTelegramDegradationWatchdog(db, signal, { operatorTelegramCreds });
    const state = () => JSON.parse(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(WATCHDOG_KEYS.notifications)!.value as string);
    const onset = () => sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(WATCHDOG_KEYS.pendingSince);
    const originalPrepare = db.prepare.bind(db);
    let capacity: FakeDbConfig = { pendingCount: 600 };
    db.prepare = (sql: string) => isPendingCapacityQuery(sql) ? makeDb(capacity).prepare(sql) : originalPrepare(sql);
    await mockSetCache(db, WATCHDOG_KEYS.pendingSince, String(Math.floor(Date.now() / 1000) - 3600));
    mockDeliverOperatorAlert.mockImplementation(async () => {
      expect(state().pending.length).toBeGreaterThan(0);
      return { ok: firstAccepted };
    });
    await run();
    const initial = state();
    expect(initial.acknowledged).toEqual(firstAccepted ? ["backlog"] : []);
    vi.advanceTimersByTime(DELIVERY_ALERT_COOLDOWN_SEC * 1000);
    mockDeliverOperatorAlert.mockResolvedValue({ ok: false });
    capacity = {};
    if (phase === "write-failed") {
      mockSetCache.mockRejectedValueOnce(new Error("notification-write"));
      await expect(run()).rejects.toThrow("notification-write");
      expect(mockSetCache.mock.lastCall![1]).toBe(WATCHDOG_KEYS.notifications);
      expect(state()).toEqual(initial);
      expect(onset()).toBeDefined();
    }
    const recovered = await run();
    expect(JSON.parse(recovered.metadata!).reason).toBe("operator-alert-delivery-failed");
    expect(onset()).toBeUndefined();
    const history = state().pending;
    expect(history).toMatchObject([{ condition: "backlog", active: !firstAccepted, latest: { active: false }, transitionCount: firstAccepted ? 1 : 2 }]);
    if (!firstAccepted) {
      expect(history[0].observedAt).toBe(initial.pending[0].observedAt);
      expect(history[0].detail).toBe(initial.pending[0].detail);
    }
    expect(state().acknowledged).toEqual(initial.acknowledged);
    capacity = { capacityError: true };
    await run();
    expect(state().pending).toEqual(history);
    capacity = { pendingCount: 700 };
    await run();
    vi.advanceTimersByTime(PENDING_BACKLOG_SUSTAINED_SEC * 1000);
    await run();
    if (phase === "batched") { capacity = {}; await run(); }
    expect(state().acknowledged).toEqual(initial.acknowledged);
    const summary = state().pending[0];
    expect(state().pending).toHaveLength(1);
    const count = phase === "batched" ? 4 : phase === "raise" ? 3 : 2;
    expect(summary.transitionCount).toBe(count);
    mockDeliverOperatorAlert.mockResolvedValue({ ok: true });
    await run();
    expect(state().pending).toEqual([]);
    expect(state().acknowledged).toEqual(summary.latest.active ? ["backlog"] : []);
    const line = (event: { active: boolean; observedAt: number; detail: string }) =>
      `${event.active ? "RAISED" : "RECOVERED"} backlog observed ${new Date(event.observedAt * 1000).toISOString()}: ${escapeHtml(event.detail)}`;
    const text = mockDeliverOperatorAlert.mock.lastCall![1];
    expect(text.split("\n").slice(1)).toEqual([
      `backlog: ${count} transitions (${count - 2} intervening)`, line(summary), `Latest: ${line(summary.latest)}`,
    ]);
    expect(text.length).toBeLessThan(4096);
    expect(recordOperatorAlertReceipt).toHaveBeenLastCalledWith(db, "telegramDelivery",
      expect.objectContaining({ delivered: true, pending: false, reason: null }), signal);
    mockDeliverOperatorAlert.mockClear();
    capacity = { pendingCount: 800 };
    await run();
    expect(deliverOperatorAlert).not.toHaveBeenCalled();
  });

  it.each([true, false])("bounds flapping history and delivers a new zero-send warning (transport succeeds %s)", async (accepted) => {
    const store = installCacheStore();
    const state = () => JSON.parse(store.values.get(WATCHDOG_KEYS.notifications)!.value);
    const now = Math.floor(Date.now() / 1000);
    const run = (config: FakeDbConfig) => runTelegramDegradationWatchdog(makeDb({ pendingCount: 600, ...config }), undefined, { operatorTelegramCreds });
    seedOnset(store, WATCHDOG_KEYS.pendingSince, now - 3600);
    if (!accepted) store.values.set(WATCHDOG_KEYS.notifications, {
      value: JSON.stringify({ version: 1, observed: [], acknowledged: [], lastDeliveredAt: null,
        pending: [true, false, true, false].map((active, i) => ({ condition: "near-ttl", active, observedAt: now - 600 + i, detail: `old-${i}` })),
      }), updatedAt: now,
    });
    mockDeliverOperatorAlert.mockResolvedValue({ ok: accepted });
    for (let i = 0; i < 144; i++) {
      await run({ nearTtl: i % 2 });
      expect(state().pending.length).toBeLessThanOrEqual(3);
      vi.advanceTimersByTime(300_000);
    }
    const near = state().pending.find((entry: { condition: string }) => entry.condition === "near-ttl");
    expect(near).toMatchObject({ active: true, transitionCount: accepted ? 5 : 147, latest: { active: true } });
    if (!accepted) expect(near).toMatchObject({ observedAt: now - 600, detail: "old-0" });
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, { value: "2", updatedAt: now });
    mockDeliverOperatorAlert.mockResolvedValue({ ok: true });
    await run({ nearTtl: 1, dispatchMetadata: dispatchWork() });
    expect(mockDeliverOperatorAlert.mock.lastCall![1]).toContain("RAISED zero-send");
    expect(state().pending).toEqual([]);
  });

  it.each([0, 3600])("groups stable identities, holds unknowns, and retains cooldown recovery after onset deletion (onset age %s)", async (onsetAge) => {
    const store = installCacheStore();
    const cached = () => store.values.get(WATCHDOG_KEYS.notifications)!;
    const run = (config: FakeDbConfig) => runTelegramDegradationWatchdog(makeDb(config), undefined, { operatorTelegramCreds });
    seedOnset(store, WATCHDOG_KEYS.pendingSince, Math.floor(Date.now() / 1000) - onsetAge);
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, { value: "2", updatedAt: 1 });
    await run({ pendingCount: 600, nearTtl: 1, dispatchMetadata: dispatchWork() });
    expect(mockDeliverOperatorAlert.mock.calls[0][1]).toMatch(/RAISED backlog[\s\S]*RAISED near-ttl[\s\S]*RAISED zero-send/);
    await run({ pendingCount: 700, nearTtl: 2, dispatchMetadata: dispatchWork() });
    const beforeUnknown = cached();
    await run({ capacityError: true });
    expect(cached()).toEqual(beforeUnknown);
    expect(deliverOperatorAlert).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(600_000);
    const nearTtlCleared = await run({ pendingCount: 600 });
    expect(JSON.parse(nearTtlCleared.metadata!).pendingBacklog).toMatchObject({ triggered: onsetAge > 0, recovered: false });
    const nearTtlRecovery = cached();
    expect(JSON.parse(nearTtlRecovery.value)).toMatchObject({
      observed: ["backlog", "zero-send"], acknowledged: ["backlog", "near-ttl", "zero-send"],
      pending: [{ condition: "near-ttl", active: false, observedAt: Math.floor(Date.now() / 1000) }],
    });
    vi.advanceTimersByTime(600_000);
    await run({ pendingCount: 600 });
    expect(cached()).toEqual(nearTtlRecovery);
    vi.advanceTimersByTime(60_000);
    const cooldown = await run({});
    expect(JSON.parse(cooldown.metadata!).alertTransitions).toMatchObject({ sent: false, cooldown: true, pending: 2 });
    expect(store.values.has(WATCHDOG_KEYS.pendingSince)).toBe(false);
    expect(JSON.parse(cached().value).pending[1])
      .toMatchObject({ condition: "backlog", active: false, observedAt: Math.floor(Date.now() / 1000) });
    expect(recordOperatorAlertReceipt).toHaveBeenLastCalledWith(expect.anything(), "telegramDelivery",
      expect.objectContaining({ pending: true, reason: "operator-alert-cooldown" }), undefined);
    vi.advanceTimersByTime(DELIVERY_ALERT_COOLDOWN_SEC * 1000);
    await run({});
    expect(mockDeliverOperatorAlert.mock.calls[1][1]).toMatch(/RECOVERED near-ttl[\s\S]*RECOVERED backlog/);
    expect(deliverOperatorAlert).toHaveBeenCalledTimes(2);
  });
});

describe("runTelegramDegradationWatchdog · abort", () => {
  it("throws when signal is already aborted", async () => {
    installCacheStore();
    const db = makeDb();
    const controller = new AbortController();
    controller.abort(new Error("scheduled abort"));

    await expect(runTelegramDegradationWatchdog(db, controller.signal)).rejects.toThrow(
      "scheduled abort",
    );
  });
});

describe("runTelegramDegradationWatchdog · aborted-run filter", () => {
  function makeDbWithCronRows(rows: Array<{
    id: number;
    startedAt: number;
    status: string;
    job?: string;
    metadata: Record<string, unknown> | null;
  }>): D1Database {
    const { sqlite, db } = fixtures.open();
    for (const row of rows) {
      sqlite.prepare(
        "INSERT INTO cron_runs (id, job, started_at, duration_ms, status, metadata) VALUES (?, ?, ?, 0, ?, ?)",
      ).run(row.id, row.job ?? "dispatch-telegram-alerts", row.startedAt, row.status,
        row.metadata == null ? null : JSON.stringify(row.metadata));
    }
    return db;
  }

  it.each([
    ["skips aborted run and reads the prior succeeded run's metadata", true],
    ["preserves the streak when every recent run aborted (no metadata)", false],
  ])("%s", async (_name, completed) => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, { value: "2", updatedAt: nowSec - 60 });
    const db = makeDbWithCronRows(completed ? [
      { id: 8, startedAt: 300, status: "error", metadata: null },
      { id: 9, startedAt: 400, status: "skipped_locked", metadata: null },
      { id: 10, startedAt: 500, job: "other-job", status: "ok", metadata: {} },
      { id: 20, startedAt: 100, status: "ok", metadata: {} },
      { id: 6, startedAt: 200, status: "ok", metadata: {} },
      {
        id: 7, startedAt: 200, status: "degraded",
        metadata: {
          eventsDetected: { dews: 1, depeg: 0, safety: 0, launch: 0 },
          messagesSent: 5,
        },
      },
    ] : [
      { id: 1, startedAt: 100, status: "error", metadata: null },
      { id: 2, startedAt: 200, status: "skipped_locked", metadata: null },
    ]);
    const { meta } = await evaluate(db);
    expect(meta.zeroSend.streak).toBe(completed ? 0 : 2);
    const value = store.values.get(WATCHDOG_KEYS.zeroSendStreak)?.value;
    if (completed) {
      expect(meta.zeroSend.runIdentity).toBe("7");
      expect(JSON.parse(value ?? "{}")).toEqual({ streak: 0, lastRunIdentity: "7" });
    } else expect(value).toBe("2");
  });
});
