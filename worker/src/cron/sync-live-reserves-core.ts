import { logWorkerEventArgs } from "../lib/structured-log";
import { raceWithTimeout } from "@shared/lib/timeout-signal";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { AdapterResult, ReserveAdapterDefinition } from "./reserve-adapters/index";
import { shouldAttemptFetch } from "../lib/circuit-breaker";
import { hasDegradingWarnings, hasFatalWarnings, validateAdapterOutput } from "./reserve-adapters/validate";
import { toErrorMessage } from "@shared/lib/error-utils";
import { throwIfAborted } from "../lib/abort";
import {
  buildReserveSyncStateRecord,
  breakerKeyForConfig,
  classifyFailure,
  isReserveAdapterAttemptChainError,
  type ConfiguredCoin,
  type LiveReserveConfig,
  type ReserveAttemptFailureSummary,
} from "./sync-live-reserves-shared";
import {
  beginReserveSyncAttempt,
  createReserveSyncAttemptId,
  didReserveSyncSuccessBecomeAuthoritative,
  finalizeReserveSyncAttempt,
  finalizeReserveSyncSuccess,
  type ReserveCompositionRecord,
  type ReserveSyncStateRecord,
} from "../lib/live-reserves-store";

const TRACKED_STABLECOIN_IDS = new Set(TRACKED_META_BY_ID.keys());
const UNALLOWLISTABLE_DEGRADED_WARNING_CODES = new Set([
  "stale-source-data",
  "material-unknown-exposure",
]);

export const ADAPTER_LATENCY_BUCKET_UPPER_BOUNDS_MS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000,
] as const;
export const ADAPTER_LATENCY_MAX_GROUPS = 128;
// Leaves 24 KiB of the scheduled metadata envelope for the reserve lane's
// existing outcome, checkpoint resume-pointer, breaker, and lease diagnostics.
export const ADAPTER_LATENCY_MAX_BYTES = 36 * 1_024;

export type AdapterLatencyStage = "primary" | "fallback";

interface AdapterLatencyHistogram {
  count: number;
  sumMs: number;
  buckets: number[];
  p50UpperBoundMs: number | null;
  p95UpperBoundMs: number | null;
}

export interface AdapterLatencyGroup {
  adapterKey: string;
  chain: string;
  stage: AdapterLatencyStage;
  cacheHit: boolean;
  attemptCount: number;
  ioCallCount: number;
  waveCount: number;
  errorCount: number;
  elapsedMs: AdapterLatencyHistogram;
}

export interface AdapterLatencySummary {
  schemaVersion: 1;
  bucketUpperBoundsMs: number[];
  groups: AdapterLatencyGroup[];
  total: {
    attemptCount: number;
    ioCallCount: number;
    waveCount: number;
    errorCount: number;
    elapsedMs: AdapterLatencyHistogram;
  };
  requestCacheHits: number;
  requestCacheMisses: number;
  omittedGroups: number;
  omittedAttempts: number;
  overflow: boolean;
}

export interface AdapterTelemetryProgress {
  attemptCount: number;
  ioCallCount: number;
  waveCount: number;
  requestCacheHits: number;
  requestCacheMisses: number;
  elapsedTotalMs: number;
  groupCount: number;
  overflow: boolean;
}

interface MutableAdapterLatencyGroup {
  adapterKey: string;
  chain: string;
  stage: AdapterLatencyStage;
  cacheHit: boolean;
  attemptCount: number;
  ioCallCount: number;
  waveCount: number;
  errorCount: number;
  elapsedCount: number;
  elapsedSumMs: number;
  buckets: number[];
}

export interface AdapterLatencyCollector {
  recordAttempt(input: {
    adapterKey: string;
    chain: string;
    stage: AdapterLatencyStage;
    cacheHit: boolean;
    ioCallCount: number;
    waveCount: number;
    elapsedMs: number;
    error: boolean;
  }): void;
  recordRequestCacheHit(): void;
  recordRequestCacheMiss(): void;
  progress(): AdapterTelemetryProgress;
  finalize(): AdapterLatencySummary;
}

const MAX_TELEMETRY_DIMENSION_CHARS = 80;
const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;

function saturatingInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_SAFE_COUNTER, Math.floor(value));
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(MAX_SAFE_COUNTER, left + saturatingInteger(right));
}

function boundedDimension(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || !/^[a-z0-9._-]+$/.test(normalized)) return fallback;
  return normalized.slice(0, MAX_TELEMETRY_DIMENSION_CHARS);
}

function percentileUpperBound(buckets: readonly number[], count: number, percentile: number): number | null {
  if (count === 0) return null;
  const target = Math.ceil(count * percentile);
  const index = buckets.findIndex((bucketCount) => bucketCount >= target);
  return index < 0 ? null : ADAPTER_LATENCY_BUCKET_UPPER_BOUNDS_MS[index]!;
}

function snapshotHistogram(group: Pick<
  MutableAdapterLatencyGroup,
  "elapsedCount" | "elapsedSumMs" | "buckets"
>): AdapterLatencyHistogram {
  return {
    count: group.elapsedCount,
    sumMs: group.elapsedSumMs,
    buckets: [...group.buckets],
    p50UpperBoundMs: percentileUpperBound(group.buckets, group.elapsedCount, 0.5),
    p95UpperBoundMs: percentileUpperBound(group.buckets, group.elapsedCount, 0.95),
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function compareDimensions(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createAdapterLatencyCollector(): AdapterLatencyCollector {
  const groups = new Map<string, MutableAdapterLatencyGroup>();
  const total: MutableAdapterLatencyGroup = {
    adapterKey: "total",
    chain: "multi",
    stage: "primary",
    cacheHit: false,
    attemptCount: 0,
    ioCallCount: 0,
    waveCount: 0,
    errorCount: 0,
    elapsedCount: 0,
    elapsedSumMs: 0,
    buckets: ADAPTER_LATENCY_BUCKET_UPPER_BOUNDS_MS.map(() => 0),
  };
  let requestCacheHits = 0;
  let requestCacheMisses = 0;

  const update = (
    group: MutableAdapterLatencyGroup,
    input: Parameters<AdapterLatencyCollector["recordAttempt"]>[0],
  ) => {
    const elapsedMs = saturatingInteger(input.elapsedMs);
    group.attemptCount = saturatingAdd(group.attemptCount, 1);
    group.ioCallCount = saturatingAdd(group.ioCallCount, input.ioCallCount);
    group.waveCount = saturatingAdd(group.waveCount, input.waveCount);
    group.errorCount = saturatingAdd(group.errorCount, input.error ? 1 : 0);
    group.elapsedCount = saturatingAdd(group.elapsedCount, 1);
    group.elapsedSumMs = saturatingAdd(group.elapsedSumMs, elapsedMs);
    for (let index = 0; index < ADAPTER_LATENCY_BUCKET_UPPER_BOUNDS_MS.length; index++) {
      if (elapsedMs <= ADAPTER_LATENCY_BUCKET_UPPER_BOUNDS_MS[index]!) {
        group.buckets[index] = saturatingAdd(group.buckets[index]!, 1);
      }
    }
  };

  const buildSummary = (): AdapterLatencySummary => {
    const snapshots = Array.from(groups.values())
      .sort((left, right) => (
        compareDimensions(left.adapterKey, right.adapterKey)
        || compareDimensions(left.chain, right.chain)
        || compareDimensions(left.stage, right.stage)
        || Number(left.cacheHit) - Number(right.cacheHit)
      ))
      .map((group): AdapterLatencyGroup => ({
        adapterKey: group.adapterKey,
        chain: group.chain,
        stage: group.stage,
        cacheHit: group.cacheHit,
        attemptCount: group.attemptCount,
        ioCallCount: group.ioCallCount,
        waveCount: group.waveCount,
        errorCount: group.errorCount,
        elapsedMs: snapshotHistogram(group),
      }));
    const retained = snapshots.slice(0, ADAPTER_LATENCY_MAX_GROUPS);
    const summary: AdapterLatencySummary = {
      schemaVersion: 1,
      bucketUpperBoundsMs: [...ADAPTER_LATENCY_BUCKET_UPPER_BOUNDS_MS],
      groups: retained,
      total: {
        attemptCount: total.attemptCount,
        ioCallCount: total.ioCallCount,
        waveCount: total.waveCount,
        errorCount: total.errorCount,
        elapsedMs: snapshotHistogram(total),
      },
      requestCacheHits,
      requestCacheMisses,
      omittedGroups: snapshots.length - retained.length,
      omittedAttempts: snapshots.slice(retained.length)
        .reduce((sum, group) => saturatingAdd(sum, group.attemptCount), 0),
      overflow: snapshots.length > retained.length,
    };

    while (utf8Bytes(JSON.stringify(summary)) > ADAPTER_LATENCY_MAX_BYTES && summary.groups.length > 0) {
      const omitted = summary.groups.pop()!;
      summary.omittedGroups = saturatingAdd(summary.omittedGroups, 1);
      summary.omittedAttempts = saturatingAdd(summary.omittedAttempts, omitted.attemptCount);
      summary.overflow = true;
    }
    return summary;
  };

  return {
    recordAttempt(input) {
      const adapterKey = boundedDimension(input.adapterKey, "unknown");
      const chain = boundedDimension(input.chain, "multi");
      const groupKey = JSON.stringify([adapterKey, chain, input.stage, input.cacheHit]);
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          adapterKey,
          chain,
          stage: input.stage,
          cacheHit: input.cacheHit,
          attemptCount: 0,
          ioCallCount: 0,
          waveCount: 0,
          errorCount: 0,
          elapsedCount: 0,
          elapsedSumMs: 0,
          buckets: ADAPTER_LATENCY_BUCKET_UPPER_BOUNDS_MS.map(() => 0),
        };
        groups.set(groupKey, group);
      }
      update(group, input);
      update(total, input);
    },
    recordRequestCacheHit() {
      requestCacheHits = saturatingAdd(requestCacheHits, 1);
    },
    recordRequestCacheMiss() {
      requestCacheMisses = saturatingAdd(requestCacheMisses, 1);
    },
    progress() {
      return {
        attemptCount: total.attemptCount,
        ioCallCount: total.ioCallCount,
        waveCount: total.waveCount,
        requestCacheHits,
        requestCacheMisses,
        elapsedTotalMs: total.elapsedSumMs,
        groupCount: groups.size,
        overflow: groups.size > ADAPTER_LATENCY_MAX_GROUPS,
      };
    },
    finalize: buildSummary,
  };
}

export type ReserveCoinSyncStatus = "synced" | "failed" | "skipped";

export interface ReserveCoinSyncResult {
  breakerKey: string;
  status: ReserveCoinSyncStatus;
  breakerOutcome?: boolean;
  warningMessages: string[];
  hasWarnings: boolean;
  attemptFailureSummaries?: ReserveAttemptFailureSummary[];
  adapterDurationMs: number;
  d1DurationMs: number;
}

export type ReserveAdapterRunner = (
  coin: ConfiguredCoin,
  config: LiveReserveConfig,
  adapter: ReserveAdapterDefinition,
) => Promise<AdapterResult>;

function getEffectiveScoringMaxSourceAgeSec(config: LiveReserveConfig, adapter: ReserveAdapterDefinition): number | undefined {
  const adapterMaxSourceAgeSec = adapter.validation?.maxSourceAgeSec;
  const scoringMaxSourceAgeSec = config.scoring?.maxSourceAgeSec;
  if (adapterMaxSourceAgeSec == null) {
    return scoringMaxSourceAgeSec;
  }
  if (scoringMaxSourceAgeSec == null) {
    return undefined;
  }
  return Math.min(scoringMaxSourceAgeSec, adapterMaxSourceAgeSec);
}

export async function syncReserveCoin(args: {
  db: D1Database;
  coin: ConfiguredCoin;
  signal: AbortSignal;
  adapter: ReserveAdapterDefinition | null | undefined;
  runAdapter: ReserveAdapterRunner;
  breakerCanFetch: Map<string, boolean>;
  previousState: ReserveSyncStateRecord | null;
  d1FinalizeTimeoutMs: number;
  onAttemptStarted?: (attemptId: string) => Promise<void>;
  onAttemptPending?: (attemptId: string) => Promise<void>;
  onAuthoritativeWrite?: (attemptId: string) => Promise<void>;
}): Promise<ReserveCoinSyncResult> {
  throwIfAborted(args.signal);

  const { db, coin, adapter, runAdapter, breakerCanFetch, previousState } = args;
  const config = coin.liveReservesConfig!;
  const breakerKey = breakerKeyForConfig(config);
  const prevSuccessAt = previousState?.lastSuccessAt ?? null;
  const prevSuccessAttemptId = previousState?.lastSuccessAttemptId ?? null;
  const attemptId = createReserveSyncAttemptId(coin.id);
  const attemptStartedAt = Math.floor(Date.now() / 1000);
  let attemptStarted = false;
  let adapterStartMs: number | null = null;
  let adapterDurationMs = 0;
  let d1DurationMs = 0;

  const timedResult = (
    result: Omit<ReserveCoinSyncResult, "adapterDurationMs" | "d1DurationMs">,
  ): ReserveCoinSyncResult => ({ ...result, adapterDurationMs, d1DurationMs });

  const recordFailure = async (
    status: ReserveSyncStateRecord["lastStatus"],
    lastError: string | null,
    reason: string,
    warnings: ReserveSyncStateRecord["warnings"] = [],
    metadataExtras?: Record<string, unknown>,
  ) => {
    if (!attemptStarted) return { finalized: false };
    const d1StartedMs = Date.now();
    try {
      return await finalizeReserveSyncAttempt(db, buildReserveSyncStateRecord({
          stablecoinId: coin.id,
          config,
          breakerKey,
          previousLastSuccessAt: prevSuccessAt,
          previousLastSuccessAttemptId: prevSuccessAttemptId,
          attemptId,
          now: attemptStartedAt,
          status,
          lastError,
          warnings,
          metadata: {
            reason,
            failureCategory: classifyFailure(reason, lastError),
            ...(metadataExtras ?? {}),
          },
      }));
    } finally {
      d1DurationMs += Date.now() - d1StartedMs;
    }
  };

  // Fence the durable scheduler checkpoint before exposing the domain attempt
  // as pending. A crash in between leaves a harmless checkpoint reference to
  // a nonexistent attempt; the opposite order could leave an untracked pending
  // attempt that recovery cannot clear with an exact compare-and-swap.
  await args.onAttemptStarted?.(attemptId);
  const beginStartedMs = Date.now();
  try {
    await beginReserveSyncAttempt(db, {
      stablecoinId: coin.id,
      adapterKey: config.adapter,
      breakerKey,
      attemptedAt: attemptStartedAt,
      attemptId,
    });
  } finally {
    d1DurationMs += Date.now() - beginStartedMs;
  }
  attemptStarted = true;
  await args.onAttemptPending?.(attemptId);

  try {
    const canFetch = breakerCanFetch.has(breakerKey)
      ? breakerCanFetch.get(breakerKey) ?? true
      : await shouldAttemptFetch(db, breakerKey);
    breakerCanFetch.set(breakerKey, canFetch);
    if (!canFetch) {
      await recordFailure("skipped", null, "circuit-open");
      return timedResult({ breakerKey, status: "skipped", warningMessages: [], hasWarnings: false });
    }

    if (!adapter) {
      logWorkerEventArgs("handler", "warn", `[sync-live-reserves] Unknown adapter "${config.adapter}" for ${coin.id}`);
      await recordFailure("error", `Unknown adapter: ${config.adapter}`, "unknown-adapter");
      return timedResult({ breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false });
    }

    adapterStartMs = Date.now();
    const result = await runAdapter(coin, config, adapter);
    const durationMs = Date.now() - adapterStartMs;
    adapterDurationMs += durationMs;
    const validation = validateAdapterOutput(result, {
      adapter,
      now: attemptStartedAt,
      maxSourceAgeSec: getEffectiveScoringMaxSourceAgeSec(config, adapter),
      subjectId: coin.id,
      knownStablecoinIds: TRACKED_STABLECOIN_IDS,
    });
    if (!validation.valid) {
      const message = validation.warnings.map((warning) => warning.message).join("; ");
      logWorkerEventArgs("handler", "warn", `[sync-live-reserves] Adapter output invalid for ${coin.id}: ${message}`);
      await recordFailure("error", `Validation failed: ${message}`, "validation-failed", validation.warnings, { durationMs });
      return timedResult({ breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false });
    }

    if (result.slices.length === 0) {
      logWorkerEventArgs("handler", "warn", `[sync-live-reserves] Adapter returned empty slices for ${coin.id}`);
      await recordFailure("error", "Adapter returned zero reserve slices", "empty-slices", [], { durationMs });
      return timedResult({ breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false });
    }

    const warnings = [...(result.warnings ?? []), ...validation.warnings];
    if (hasFatalWarnings(warnings)) {
      const message = warnings
        .filter((warning) => warning.effect === "fatal")
        .map((warning) => warning.message)
        .join("; ");
      await recordFailure("error", message || "Fatal reserve adapter warning", "fatal-warning", warnings, { durationMs });
      return timedResult({ breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false });
    }

    const allowedDegradedWarningCodes = new Set(config.scoring?.allowedDegradedWarningCodes ?? []);
    const degradedWarningsOutsideAllowlist = warnings.filter((warning) => (
      warning.effect === "degraded"
      && (
        UNALLOWLISTABLE_DEGRADED_WARNING_CODES.has(warning.code)
        || !allowedDegradedWarningCodes.has(warning.code)
      )
    ));

    const snapshotMetadata = {
      ...(result.metadata ?? {}),
      durationMs,
    };

    const compositionRecord: ReserveCompositionRecord = {
      stablecoinId: coin.id,
      slices: result.slices,
      fetchedAt: attemptStartedAt,
      source: config.adapter,
      attemptId,
      metadata: snapshotMetadata,
      warningCount: warnings.length,
      warnings,
      adapterSourceModel: adapter.sourceModel,
      adapterEvidenceClass: adapter.evidenceClass,
    };

    const successState = buildReserveSyncStateRecord({
      stablecoinId: coin.id,
      config,
      breakerKey,
      previousLastSuccessAt: prevSuccessAt,
      previousLastSuccessAttemptId: prevSuccessAttemptId,
      attemptId,
      now: attemptStartedAt,
      status: hasDegradingWarnings(degradedWarningsOutsideAllowlist) ? "degraded" : "ok",
      warnings,
      metadata: {
        warningEffects: {
          info: warnings.filter((warning) => warning.effect === "info").length,
          degraded: warnings.filter((warning) => warning.effect === "degraded").length,
          fatal: warnings.filter((warning) => warning.effect === "fatal").length,
        },
        durationMs,
      },
      lastSuccessAt: attemptStartedAt,
      lastSuccessAttemptId: attemptId,
    });

    let finalizeSucceeded = false;
    let historyWriteFailed: string | null = null;
    let failureAlreadyRecorded = false;
    const finalizeStartedMs = Date.now();
    try {
      const finalizeResult = await raceWithTimeout(
        finalizeReserveSyncSuccess(
          db,
          compositionRecord,
          successState,
          Date.now() + args.d1FinalizeTimeoutMs,
          args.onAuthoritativeWrite ? () => args.onAuthoritativeWrite!(attemptId) : undefined,
        ),
        args.d1FinalizeTimeoutMs,
        `D1 write timeout for ${coin.id}`,
      );
      finalizeSucceeded = finalizeResult.finalized;
      if (finalizeResult.finalized && !finalizeResult.historyRecorded) {
        historyWriteFailed = finalizeResult.historyError ?? "unknown history write failure";
        logWorkerEventArgs("handler", "warn", `[sync-live-reserves] History write failed after authoritative success for ${coin.id}: ${historyWriteFailed}`);
      }
    } catch (error) {
      const timeoutMessage = `D1 write timeout for ${coin.id}`;
      if (!(error instanceof Error) || error.message !== timeoutMessage) {
        throw error;
      }

      if (
        await didReserveSyncSuccessBecomeAuthoritative(
          db,
          compositionRecord.stablecoinId,
          compositionRecord.fetchedAt,
          compositionRecord.attemptId,
        )
      ) {
        logWorkerEventArgs("handler", "warn", `[sync-live-reserves] ${timeoutMessage}; authoritative success confirmed by readback`);
        finalizeSucceeded = true;
        historyWriteFailed = "D1 write timed out after authoritative success readback";
      }

      if (!finalizeSucceeded) {
        logWorkerEventArgs("handler", "warn", `[sync-live-reserves] ${timeoutMessage}; clearing pending attempt authority`);
        await recordFailure("error", timeoutMessage, "storage-write-timeout", warnings, {
          uncertainWrite: true,
          durationMs,
        });
        failureAlreadyRecorded = true;
      }
    } finally {
      d1DurationMs += Date.now() - finalizeStartedMs;
    }

    if (!finalizeSucceeded) {
      if (!failureAlreadyRecorded) {
        await recordFailure(
          "error",
          `Authoritative live reserve finalize rejected for ${coin.id}`,
          "success-finalize-rejected",
          warnings,
          { uncertainWrite: true, durationMs },
        );
      }
      return timedResult({ breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false });
    }

    const warningMessages = warnings.map((warning) => `${coin.id}:${warning.code}`);
    if (historyWriteFailed) {
      warningMessages.push(`${coin.id}:history-write-failed`);
    }

    return timedResult({
      breakerKey,
      status: "synced",
      breakerOutcome: true,
      warningMessages,
      hasWarnings: warningMessages.length > 0,
    });
  } catch (error) {
    logWorkerEventArgs("handler", "error", `[sync-live-reserves] Failed for ${coin.id}:`, error);
    const extras: Record<string, unknown> = {};
    let attemptFailureSummaries: ReserveAttemptFailureSummary[] | undefined;
    if (isReserveAdapterAttemptChainError(error)) {
      extras.attemptSummaries = error.attemptSummaries;
      attemptFailureSummaries = error.attemptSummaries;
    }
    if (adapterStartMs !== null) {
      const elapsed = Date.now() - adapterStartMs;
      if (adapterDurationMs === 0) adapterDurationMs = elapsed;
      extras.durationMs = elapsed;
    }
    await recordFailure(
      "error",
      toErrorMessage(error),
      "adapter-exception",
      [],
      Object.keys(extras).length > 0 ? extras : undefined,
    );
    return timedResult({
      breakerKey,
      status: "failed",
      breakerOutcome: false,
      warningMessages: [],
      hasWarnings: false,
      ...(attemptFailureSummaries ? { attemptFailureSummaries } : {}),
    });
  }
}
