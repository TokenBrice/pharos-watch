import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { raceWithTimeout } from "@shared/lib/timeout-signal";
import type { AdapterResult, ReserveAdapterDefinition } from "./reserve-adapters/index";
import { shouldAttemptFetch } from "../lib/circuit-breaker";
import { hasDegradingWarnings, hasFatalWarnings, validateAdapterOutput } from "./reserve-adapters/validate";
import {
  buildReserveSyncStateRecord,
  breakerKeyForConfig,
  classifyFailure,
} from "./sync-live-reserves-shared";
import {
  beginReserveSyncAttempt,
  createReserveSyncAttemptId,
  didReserveSyncAttemptFinalizeAsSuccess,
  finalizeReserveSyncAttempt,
  finalizeReserveSyncSuccess,
  getReserveSyncState,
  type ReserveCompositionRecord,
  type ReserveSyncStateRecord,
} from "../lib/live-reserves-store";

const _CONFIGURED_COINS = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig);
type ConfiguredCoin = (typeof _CONFIGURED_COINS)[number];
type LiveReserveConfig = NonNullable<ConfiguredCoin["liveReservesConfig"]>;

export type ReserveCoinSyncStatus = "synced" | "failed" | "skipped";

export interface ReserveCoinSyncResult {
  breakerKey: string;
  status: ReserveCoinSyncStatus;
  breakerOutcome?: boolean;
  warningMessages: string[];
  hasWarnings: boolean;
}

export type ReserveAdapterRunner = (
  coin: ConfiguredCoin,
  config: LiveReserveConfig,
  adapter: ReserveAdapterDefinition,
) => Promise<AdapterResult>;

const D1_WRITE_FINALIZE_TIMEOUT_MS = 30_000;

export async function syncReserveCoin(args: {
  db: D1Database;
  coin: ConfiguredCoin;
  signal: AbortSignal;
  adapter: ReserveAdapterDefinition | null | undefined;
  runAdapter: ReserveAdapterRunner;
  breakerCanFetch: Map<string, boolean>;
  previousState: ReserveSyncStateRecord | null;
}): Promise<ReserveCoinSyncResult> {
  if (args.signal?.aborted) {
    throw args.signal.reason ?? new Error("sync-live-reserves aborted");
  }

  const { db, coin, adapter, runAdapter, breakerCanFetch, previousState } = args;
  const config = coin.liveReservesConfig!;
  const breakerKey = breakerKeyForConfig(config);
  const prevSuccessAt = previousState?.lastSuccessAt ?? null;
  const prevSuccessAttemptId = previousState?.lastSuccessAttemptId ?? null;
  const attemptId = createReserveSyncAttemptId(coin.id);
  const attemptStartedAt = Math.floor(Date.now() / 1000);
  let attemptStarted = false;

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

    const result = await runAdapter(coin, config, adapter);
    const validation = validateAdapterOutput(result, { adapter, now: attemptStartedAt });
    if (!validation.valid) {
      const message = validation.warnings.map((warning) => warning.message).join("; ");
      console.warn(`[sync-live-reserves] Adapter output invalid for ${coin.id}: ${message}`);
      await recordFailure("error", `Validation failed: ${message}`, "validation-failed", validation.warnings);
      return { breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false };
    }

    if (result.slices.length === 0) {
      console.warn(`[sync-live-reserves] Adapter returned empty slices for ${coin.id}`);
      await recordFailure("error", "Adapter returned zero reserve slices", "empty-slices");
      return { breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false };
    }

    const warnings = [...(result.warnings ?? []), ...validation.warnings];
    if (hasFatalWarnings(warnings)) {
      const message = warnings
        .filter((warning) => warning.effect === "fatal")
        .map((warning) => warning.message)
        .join("; ");
      await recordFailure("error", message || "Fatal reserve adapter warning", "fatal-warning", warnings);
      return { breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false };
    }

    const compositionRecord: ReserveCompositionRecord = {
      stablecoinId: coin.id,
      slices: result.slices,
      fetchedAt: attemptStartedAt,
      source: config.adapter,
      attemptId,
      metadata: result.metadata ?? {},
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
      },
      lastSuccessAt: attemptStartedAt,
      lastSuccessAttemptId: attemptId,
    });

    let finalizeSucceeded = false;
    try {
      const finalizeResult = await raceWithTimeout(
        finalizeReserveSyncSuccess(
          db,
          compositionRecord,
          successState,
          Date.now() + D1_WRITE_FINALIZE_TIMEOUT_MS,
        ),
        D1_WRITE_FINALIZE_TIMEOUT_MS,
        `D1 write timeout for ${coin.id}`,
      );
      finalizeSucceeded = finalizeResult.finalized;
    } catch (error) {
      const timeoutMessage = `D1 write timeout for ${coin.id}`;
      if (!(error instanceof Error) || error.message !== timeoutMessage) {
        throw error;
      }

      console.warn(`[sync-live-reserves] ${timeoutMessage}; clearing pending attempt authority`);
      await recordFailure("error", timeoutMessage, "storage-write-timeout", warnings, {
        uncertainWrite: true,
      });
    }

    if (!finalizeSucceeded) {
      const latestState = await getReserveSyncState(db, coin.id).catch(() => null);
      if (!didReserveSyncAttemptFinalizeAsSuccess(latestState, attemptId)) {
        await recordFailure(
          "error",
          `Authoritative live reserve finalize rejected for ${coin.id}`,
          "success-finalize-rejected",
          warnings,
          { uncertainWrite: true },
        );
        return { breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false };
      }
    }

    return {
      breakerKey,
      status: "synced",
      breakerOutcome: true,
      warningMessages: warnings.map((warning) => `${coin.id}:${warning.code}`),
      hasWarnings: warnings.length > 0,
    };
  } catch (error) {
    console.error(`[sync-live-reserves] Failed for ${coin.id}:`, error);
    await recordFailure("error", error instanceof Error ? error.message : String(error), "adapter-exception");
    return { breakerKey, status: "failed", breakerOutcome: false, warningMessages: [], hasWarnings: false };
  }
}
