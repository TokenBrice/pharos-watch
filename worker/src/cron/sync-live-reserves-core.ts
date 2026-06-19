import { raceWithTimeout } from "@shared/lib/timeout-signal";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
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

export type ReserveCoinSyncStatus = "synced" | "failed" | "skipped";

export interface ReserveCoinSyncResult {
  breakerKey: string;
  status: ReserveCoinSyncStatus;
  breakerOutcome?: boolean;
  warningMessages: string[];
  hasWarnings: boolean;
  attemptFailureSummaries?: ReserveAttemptFailureSummary[];
}

export type ReserveAdapterRunner = (
  coin: ConfiguredCoin,
  config: LiveReserveConfig,
  adapter: ReserveAdapterDefinition,
) => Promise<AdapterResult>;

function getScoringRelevantWarnings(
  warnings: readonly LiveReserveWarning[],
  config: LiveReserveConfig,
): LiveReserveWarning[] {
  const allowedCodes = new Set(config.scoring?.allowedDegradedWarningCodes ?? []);
  return warnings.filter((warning) =>
    warning.effect !== "degraded" || !allowedCodes.has(warning.code),
  );
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

  const recordFailure = (
    status: ReserveSyncStateRecord["lastStatus"],
    lastError: string | null,
    reason: string,
    warnings: ReserveSyncStateRecord["warnings"] = [],
    metadataExtras?: Record<string, unknown>,
  ) => (
    attemptStarted
      ? finalizeReserveSyncAttempt(db, buildReserveSyncStateRecord({
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
        }))
      : Promise.resolve({ finalized: false })
  );

  await beginReserveSyncAttempt(db, {
    stablecoinId: coin.id,
    adapterKey: config.adapter,
    breakerKey,
    attemptedAt: attemptStartedAt,
    attemptId,
  });
  attemptStarted = true;

  try {
    const canFetch = breakerCanFetch.has(breakerKey)
      ? breakerCanFetch.get(breakerKey) ?? true
      : await shouldAttemptFetch(db, breakerKey);
    breakerCanFetch.set(breakerKey, canFetch);
    if (!canFetch) {
      await recordFailure("skipped", null, "circuit-open");
      return { breakerKey, status: "skipped", warningMessages: [], hasWarnings: false };
    }

    if (!adapter) {
      console.warn(`[sync-live-reserves] Unknown adapter "${config.adapter}" for ${coin.id}`);
      await recordFailure("error", `Unknown adapter: ${config.adapter}`, "unknown-adapter");
      return { breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false };
    }

    adapterStartMs = Date.now();
    const result = await runAdapter(coin, config, adapter);
    const durationMs = Date.now() - adapterStartMs;
    const validation = validateAdapterOutput(result, {
      adapter,
      now: attemptStartedAt,
      maxSourceAgeSec: config.scoring?.maxSourceAgeSec ?? undefined,
    });
    if (!validation.valid) {
      const message = validation.warnings.map((warning) => warning.message).join("; ");
      console.warn(`[sync-live-reserves] Adapter output invalid for ${coin.id}: ${message}`);
      await recordFailure("error", `Validation failed: ${message}`, "validation-failed", validation.warnings, { durationMs });
      return { breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false };
    }

    if (result.slices.length === 0) {
      console.warn(`[sync-live-reserves] Adapter returned empty slices for ${coin.id}`);
      await recordFailure("error", "Adapter returned zero reserve slices", "empty-slices", [], { durationMs });
      return { breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false };
    }

    const warnings = [...(result.warnings ?? []), ...validation.warnings];
    if (hasFatalWarnings(warnings)) {
      const message = warnings
        .filter((warning) => warning.effect === "fatal")
        .map((warning) => warning.message)
        .join("; ");
      await recordFailure("error", message || "Fatal reserve adapter warning", "fatal-warning", warnings, { durationMs });
      return { breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false };
    }

    const scoringAllowsUnverifiedFreshness = config.scoring?.maxSourceAgeSec != null
      && result.metadata?.freshnessMode === "unverified";
    const snapshotMetadata = {
      ...(result.metadata ?? {}),
      ...(scoringAllowsUnverifiedFreshness ? { scoringAllowsUnverifiedFreshness: true } : {}),
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

    const scoringRelevantWarnings = getScoringRelevantWarnings(warnings, config);
    const successState = buildReserveSyncStateRecord({
      stablecoinId: coin.id,
      config,
      breakerKey,
      previousLastSuccessAt: prevSuccessAt,
      previousLastSuccessAttemptId: prevSuccessAttemptId,
      attemptId,
      now: attemptStartedAt,
      status: hasDegradingWarnings(scoringRelevantWarnings) ? "degraded" : "ok",
      warnings,
      metadata: {
        warningEffects: {
          info: warnings.filter((warning) => warning.effect === "info").length,
          degraded: warnings.filter((warning) => warning.effect === "degraded").length,
          fatal: warnings.filter((warning) => warning.effect === "fatal").length,
        },
        scoringAllowsUnverifiedFreshness,
        durationMs,
      },
      lastSuccessAt: attemptStartedAt,
      lastSuccessAttemptId: attemptId,
    });

    let finalizeSucceeded = false;
    let historyWriteFailed: string | null = null;
    let failureAlreadyRecorded = false;
    try {
      const finalizeResult = await raceWithTimeout(
        finalizeReserveSyncSuccess(
          db,
          compositionRecord,
          successState,
          Date.now() + args.d1FinalizeTimeoutMs,
        ),
        args.d1FinalizeTimeoutMs,
        `D1 write timeout for ${coin.id}`,
      );
      finalizeSucceeded = finalizeResult.finalized;
      if (finalizeResult.finalized && !finalizeResult.historyRecorded) {
        historyWriteFailed = finalizeResult.historyError ?? "unknown history write failure";
        console.warn(`[sync-live-reserves] History write failed after authoritative success for ${coin.id}: ${historyWriteFailed}`);
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
        console.warn(`[sync-live-reserves] ${timeoutMessage}; authoritative success confirmed by readback`);
        finalizeSucceeded = true;
        historyWriteFailed = "D1 write timed out after authoritative success readback";
      }

      if (!finalizeSucceeded) {
        console.warn(`[sync-live-reserves] ${timeoutMessage}; clearing pending attempt authority`);
        await recordFailure("error", timeoutMessage, "storage-write-timeout", warnings, {
          uncertainWrite: true,
          durationMs,
        });
        failureAlreadyRecorded = true;
      }
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
      return { breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false };
    }

    const warningMessages = warnings.map((warning) => `${coin.id}:${warning.code}`);
    if (historyWriteFailed) {
      warningMessages.push(`${coin.id}:history-write-failed`);
    }

    return {
      breakerKey,
      status: "synced",
      breakerOutcome: true,
      warningMessages,
      hasWarnings: warningMessages.length > 0,
    };
  } catch (error) {
    console.error(`[sync-live-reserves] Failed for ${coin.id}:`, error);
    const extras: Record<string, unknown> = {};
    let attemptFailureSummaries: ReserveAttemptFailureSummary[] | undefined;
    if (isReserveAdapterAttemptChainError(error)) {
      extras.attemptSummaries = error.attemptSummaries;
      attemptFailureSummaries = error.attemptSummaries;
    }
    if (adapterStartMs !== null) {
      extras.durationMs = Date.now() - adapterStartMs;
    }
    await recordFailure(
      "error",
      toErrorMessage(error),
      "adapter-exception",
      [],
      Object.keys(extras).length > 0 ? extras : undefined,
    );
    return {
      breakerKey,
      status: "failed",
      breakerOutcome: false,
      warningMessages: [],
      hasWarnings: false,
      ...(attemptFailureSummaries ? { attemptFailureSummaries } : {}),
    };
  }
}
