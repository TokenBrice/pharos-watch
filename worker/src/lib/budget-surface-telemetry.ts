import { CRON_CONNECTION_BUDGET_ENTRIES } from "@shared/lib/cron-jobs";
import { isRecord } from "@shared/lib/type-guards";
import type { BudgetOnlySurfaceStatus } from "@shared/types/status";
import { buildInClause } from "./db";
import { setCache } from "./db-cache";
import { toErrorMessage } from "./error-utils";
import { logWorkerEvent } from "./structured-log";
import { recordProducerOutcome, type ProducerIdentity } from "./producer-history";

const CACHE_PREFIX = "cron:budget-surface:";
const CACHE_VERSION = 1;

export type BudgetSurfaceOutcome = "ok" | "degraded" | "error" | "skipped";

export interface BudgetSurfaceTelemetryInput {
  surface: string;
  checkedAt?: number;
  durationMs: number;
  dueCount: number;
  processedCount: number;
  outcome: BudgetSurfaceOutcome;
  skippedReason?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  producer?: ProducerIdentity;
}

interface BudgetSurfaceTelemetryPayload {
  version: typeof CACHE_VERSION;
  surface: string;
  checkedAt: number;
  durationMs: number;
  dueCount: number;
  processedCount: number;
  outcome: BudgetSurfaceOutcome;
  skippedReason?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

interface BudgetSurfaceTelemetryRow {
  key: string;
  value: string | null;
  updated_at: number;
}

const BUDGET_ONLY_DEFINITIONS = CRON_CONNECTION_BUDGET_ENTRIES.filter((entry) => !entry.statusTracked);
const BUDGET_ONLY_BY_KEY = new Map(
  BUDGET_ONLY_DEFINITIONS.map((entry) => [budgetSurfaceTelemetryCacheKey(entry.job), entry]),
);

function budgetSurfaceTelemetryCacheKey(surface: string): string {
  return `${CACHE_PREFIX}${surface}`;
}

function isBudgetSurfaceOutcome(value: unknown): value is BudgetSurfaceOutcome {
  return value === "ok" || value === "degraded" || value === "error" || value === "skipped";
}

function sanitizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).slice(0, 24).map(([key, entry]) => {
    if (entry == null || typeof entry === "number" || typeof entry === "boolean") return [key, entry] as const;
    if (typeof entry === "string") return [key, entry.slice(0, 500)] as const;
    if (Array.isArray(entry)) return [key, entry.slice(0, 24)] as const;
    if (typeof entry === "object") return [key, entry] as const;
    return [key, String(entry).slice(0, 500)] as const;
  });
  return Object.fromEntries(entries);
}

function parseTelemetryPayload(value: string | null | undefined): BudgetSurfaceTelemetryPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.version !== CACHE_VERSION) return null;
    if (typeof parsed.surface !== "string") return null;
    if (typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt)) return null;
    if (typeof parsed.durationMs !== "number" || !Number.isFinite(parsed.durationMs)) return null;
    if (typeof parsed.dueCount !== "number" || !Number.isFinite(parsed.dueCount)) return null;
    if (typeof parsed.processedCount !== "number" || !Number.isFinite(parsed.processedCount)) return null;
    if (!isBudgetSurfaceOutcome(parsed.outcome)) return null;
    const metadata = parsed.metadata;
    return {
      version: CACHE_VERSION,
      surface: parsed.surface,
      checkedAt: parsed.checkedAt,
      durationMs: Math.max(0, Math.round(parsed.durationMs)),
      dueCount: Math.max(0, Math.round(parsed.dueCount)),
      processedCount: Math.max(0, Math.round(parsed.processedCount)),
      outcome: parsed.outcome,
      ...(typeof parsed.skippedReason === "string" ? { skippedReason: parsed.skippedReason.slice(0, 300) } : {}),
      ...(typeof parsed.error === "string" ? { error: parsed.error.slice(0, 500) } : {}),
      ...(isRecord(metadata) ? { metadata: sanitizeMetadata(metadata) } : {}),
    };
  } catch {
    return null;
  }
}

function buildUnknownSurfaceStatuses(): BudgetOnlySurfaceStatus[] {
  return BUDGET_ONLY_DEFINITIONS.map((entry) => ({
    job: entry.job,
    label: entry.label,
    scheduleKey: entry.scheduleKey,
    schedule: entry.schedule,
    expectedIntervalSec: entry.intervalSec,
    maxAgeSec: entry.intervalSec * 2,
    maxConnections: entry.maxConnections,
    connectionGroup: entry.connectionGroup,
    telemetryStatus: "missing",
    telemetryUnknown: true,
    checkedAt: null,
    ageSeconds: null,
    durationMs: null,
    dueCount: null,
    processedCount: null,
    outcome: "unknown",
  }));
}

function buildSurfaceStatus(
  row: BudgetSurfaceTelemetryRow,
  now: number,
): BudgetOnlySurfaceStatus {
  const definition = BUDGET_ONLY_BY_KEY.get(row.key);
  if (!definition) {
    throw new Error("buildSurfaceStatus called without a matching budget-only definition");
  }

  const payload = parseTelemetryPayload(row.value);
  const checkedAt = payload?.checkedAt ?? row.updated_at;
  const ageSeconds = Math.max(0, now - checkedAt);
  const maxAgeSec = definition.intervalSec * 2;
  const telemetryStatus: BudgetOnlySurfaceStatus["telemetryStatus"] = payload
    ? ageSeconds > maxAgeSec ? "stale" : "fresh"
    : "unreadable";

  return {
    job: definition.job,
    label: definition.label,
    scheduleKey: definition.scheduleKey,
    schedule: definition.schedule,
    expectedIntervalSec: definition.intervalSec,
    maxAgeSec,
    maxConnections: definition.maxConnections,
    connectionGroup: definition.connectionGroup,
    telemetryStatus,
    telemetryUnknown: false,
    checkedAt,
    ageSeconds,
    durationMs: payload?.durationMs ?? null,
    dueCount: payload?.dueCount ?? null,
    processedCount: payload?.processedCount ?? null,
    outcome: payload?.outcome ?? "unknown",
    skippedReason: payload?.skippedReason ?? null,
    error: payload?.error ?? null,
    metadata: payload?.metadata,
  };
}

export async function recordBudgetSurfaceTelemetry(
  db: D1Database,
  input: BudgetSurfaceTelemetryInput,
): Promise<void> {
  const checkedAt = input.checkedAt ?? Math.floor(Date.now() / 1000);
  const payload: BudgetSurfaceTelemetryPayload = {
    version: CACHE_VERSION,
    surface: input.surface,
    checkedAt,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    dueCount: Math.max(0, Math.round(input.dueCount)),
    processedCount: Math.max(0, Math.round(input.processedCount)),
    outcome: input.outcome,
    ...(input.skippedReason ? { skippedReason: input.skippedReason.slice(0, 300) } : {}),
    ...(input.error ? { error: input.error.slice(0, 500) } : {}),
    ...(input.metadata ? { metadata: sanitizeMetadata(input.metadata) } : {}),
  };

  try {
    await setCache(db, budgetSurfaceTelemetryCacheKey(input.surface), JSON.stringify(payload));
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "budget_surface_telemetry_persist_failed",
      source: input.surface,
      message: "Budget-only scheduled surface telemetry could not be persisted",
      error,
    });
  }

  if (input.producer) {
    const invokedAt = Math.max(0, checkedAt - Math.ceil(payload.durationMs / 1_000));
    await recordProducerOutcome(db, {
      ...input.producer,
      idempotencyKey: `budget-surface:${input.producer.invocationId}:${input.surface}`,
      invokedAt,
      completedAt: checkedAt,
      outcome: input.outcome === "skipped" ? "skipped_neutral" : input.outcome,
      itemCount: payload.processedCount,
      metadata: JSON.stringify(payload),
      error: payload.error ?? null,
      productivity: {
        productive: payload.processedCount > 0 && input.outcome !== "error",
        reason: payload.processedCount > 0 ? "budget-work-processed" : payload.skippedReason ?? "no-due-work",
      },
    });
  }
}

export async function loadBudgetOnlySurfaceStatuses(
  db: D1Database,
  now: number,
): Promise<{ surfaces: BudgetOnlySurfaceStatus[]; queryFailed: boolean }> {
  const keys = BUDGET_ONLY_DEFINITIONS.map((entry) => budgetSurfaceTelemetryCacheKey(entry.job));
  if (keys.length === 0) return { surfaces: [], queryFailed: false };

  try {
    const keyClause = buildInClause(keys);
    const rows = await db
      .prepare(
        `SELECT key, value, updated_at
           FROM cache
           WHERE key IN (${keyClause.sql})`,
      )
      .bind(...keyClause.binds)
      .all<BudgetSurfaceTelemetryRow>();
    const rowByKey = new Map((rows.results ?? []).map((row) => [row.key, row]));
    const unknownByJob = new Map(buildUnknownSurfaceStatuses().map((surface) => [surface.job, surface]));
    return {
      surfaces: BUDGET_ONLY_DEFINITIONS.map((definition) => {
        const key = budgetSurfaceTelemetryCacheKey(definition.job);
        const row = rowByKey.get(key);
        if (row) return buildSurfaceStatus(row, now);
        return unknownByJob.get(definition.job)!;
      }),
      queryFailed: false,
    };
  } catch (error) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "budget_surface_telemetry_unavailable",
      route: "status",
      source: "cache",
      message: "Budget-only scheduled surface telemetry unavailable",
      error: toErrorMessage(error),
    });
    return { surfaces: buildUnknownSurfaceStatuses(), queryFailed: true };
  }
}
