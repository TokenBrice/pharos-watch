import { logWorkerEventArgs } from "../lib/structured-log";
import { raceWithTimeout } from "@shared/lib/timeout-signal";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { AdapterResult, ReserveAdapterDefinition } from "./reserve-adapters/index";
import { shouldAttemptFetch } from "../lib/circuit-breaker";
import { hasDegradingWarnings, hasFatalWarnings, validateAdapterOutput } from "./reserve-adapters/validate";
import { toErrorMessage } from "../lib/error-utils";
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
      status: hasDegradingWarnings(warnings) ? "degraded" : "ok",
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
