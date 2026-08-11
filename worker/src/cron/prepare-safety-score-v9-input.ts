import { getCacheUpdatedAt, setCacheMany } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { sleepWithSignal, throwIfAborted } from "../lib/abort";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { buildNativeSafetyScoreV9Capture } from "../lib/safety-score-v9-capture";
import { buildNativeV9InputCacheEntry } from "../lib/safety-score-v9-native-input";
import { loadStablecoinsCache, type StablecoinsCacheLoadResult } from "../lib/stablecoins-cache";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import {
  buildSafetyScoreV9PegProvenanceSeedCacheEntry,
  captureSafetyScoreV9PegProvenanceById,
} from "../lib/safety-score-v9-peg-provenance";

export const V9_INPUT_STABLECOINS_SETTLE_MAX_WAIT_MS = 3 * 60_000;
const V9_INPUT_STABLECOINS_SETTLE_POLL_MS = 2_500;

interface ActiveStablecoinsProgressRow {
  started_at: number;
  updated_at: number;
  stage: string | null;
  lease_owner: string;
  lease_until: number;
}

type StablecoinsCacheReadiness =
  | {
      status: "ready";
      cache: StablecoinsCacheLoadResult;
      waitedMs: number;
      pendingStartedAt: number | null;
    }
  | {
      status: "pending";
      waitedMs: number;
      cacheUpdatedAt: number | null;
      pendingStartedAt: number;
      pendingStage: string | null;
    };

async function readActiveStablecoinsProgress(
  db: D1Database,
  signal?: AbortSignal,
): Promise<ActiveStablecoinsProgressRow | null> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT COALESCE(p.started_at, l.heartbeat_at) AS started_at,
                  COALESCE(p.updated_at, l.heartbeat_at) AS updated_at,
                  p.stage,
                  l.lease_owner,
                  l.lease_until
             FROM cron_leases l
             LEFT JOIN cron_run_progress p
               ON p.job = l.job
              AND p.lease_owner = l.lease_owner
            WHERE l.job = 'sync-stablecoins'
              AND l.lease_until >= ?
            LIMIT 1`,
        )
        .bind(nowSec)
        .first<ActiveStablecoinsProgressRow>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return row ?? null;
}

async function waitForStablecoinsCacheReadiness(
  db: D1Database,
  signal?: AbortSignal,
  options: {
    maxWaitMs?: number;
    pollMs?: number;
  } = {},
): Promise<StablecoinsCacheReadiness> {
  const maxWaitMs = options.maxWaitMs ?? V9_INPUT_STABLECOINS_SETTLE_MAX_WAIT_MS;
  const pollMs = options.pollMs ?? V9_INPUT_STABLECOINS_SETTLE_POLL_MS;
  const waitStartedAt = Date.now();
  let pendingStartedAt: number | null = null;

  while (true) {
    throwIfAborted(signal);
    const [cacheUpdatedAt, progress] = await Promise.all([
      getCacheUpdatedAt(db, "stablecoins"),
      readActiveStablecoinsProgress(db, signal),
    ]);
    pendingStartedAt = progress?.started_at ?? pendingStartedAt;

    if (!progress || (cacheUpdatedAt != null && cacheUpdatedAt >= progress.started_at)) {
      const cache = await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
      return {
        status: "ready",
        cache,
        waitedMs: Date.now() - waitStartedAt,
        pendingStartedAt,
      };
    }

    const waitedMs = Date.now() - waitStartedAt;
    if (waitedMs >= maxWaitMs) {
      return {
        status: "pending",
        waitedMs,
        cacheUpdatedAt,
        pendingStartedAt: progress.started_at,
        pendingStage: progress.stage,
      };
    }

    await sleepWithSignal(Math.min(pollMs, maxWaitMs - waitedMs), signal);
  }
}

/**
 * Captures the native V9 scoring input and its ephemeral peg-provenance seed.
 *
 * The cron writes exactly two cache rows, both bound to the same `v9-input`
 * identity: the envelope-v2 capture and the peg-provenance seed. It no longer
 * builds V8 report cards on the way — publishing the peg-analytics aggregate is
 * now an explicit step inside the capture rather than a side effect of the
 * report-card snapshot builder.
 */
export async function prepareSafetyScoreV9Input(
  db: D1Database,
  signal?: AbortSignal,
  expectedDexGenerationId?: string,
): Promise<CronResult> {
  throwIfAborted(signal);

  const stablecoinsReadiness = await waitForStablecoinsCacheReadiness(db, signal);
  if (stablecoinsReadiness.status === "pending") {
    return {
      status: "degraded",
      itemCount: 0,
      productivity: {
        productive: false,
        reason: "safety-score-v9-input-source-unavailable",
      },
      metadata: JSON.stringify({
        stage: "stablecoins-cache-readiness",
        reason: "stablecoins-generation-pending",
        waitedMs: stablecoinsReadiness.waitedMs,
        cacheUpdatedAt: stablecoinsReadiness.cacheUpdatedAt,
        pendingStablecoinsStartedAt: stablecoinsReadiness.pendingStartedAt,
        pendingStablecoinsStage: stablecoinsReadiness.pendingStage,
      }),
    };
  }

  const capture = await buildNativeSafetyScoreV9Capture(db, {
    ...(expectedDexGenerationId === undefined ? {} : { expectedDexGenerationId }),
    preloadedStablecoinsCache: stablecoinsReadiness.cache,
  });

  throwIfAborted(signal);

  const input = capture.input;
  const publicationGenerationId = input.sourceGeneration;
  const safetyScoreIdentity = buildSafetyScoreV9InputIdentity({
    methodologyVersion: input.methodologyVersion,
    baseInputGenerationId: input.baseInputGenerationId,
    publicationGenerationId,
  });
  const inputEntry = await buildNativeV9InputCacheEntry(input, safetyScoreIdentity);
  let v9SeedEntry:
    ReturnType<typeof buildSafetyScoreV9PegProvenanceSeedCacheEntry> | null =
    null;
  let v9ExactSeed: Record<string, unknown>;
  try {
    const pegProvenanceById =
      captureSafetyScoreV9PegProvenanceById(
        input,
        capture.v9PegProvenanceSource,
      );
    v9SeedEntry = buildSafetyScoreV9PegProvenanceSeedCacheEntry({
      sourceGeneration: input.sourceGeneration,
      clockSec: input.clockSec,
      safetyScoreIdentity,
      pegProvenanceById,
    });
    v9ExactSeed = {
      status: "published",
      pegProvenanceCount: Object.keys(pegProvenanceById).length,
      storedBytes: v9SeedEntry.storedBytes,
    };
  } catch (error) {
    v9ExactSeed = {
      status: "unavailable",
      code:
        error instanceof Error && error.name
          ? error.name.slice(0, 160)
          : "Error",
    };
  }
  await setCacheMany(
    db,
    [
      inputEntry,
      ...(v9SeedEntry ? [v9SeedEntry] : []),
    ],
    signal,
  );

  return {
    itemCount: capture.completeness.expectedCount,
    productivity: {
      productive: true,
      reason: "safety-score-v9-input-published",
    },
    metadata: JSON.stringify({
      updatedAt: input.updatedAt,
      activeAssets: input.activeAssetIds.length,
      activeCards: capture.completeness.expectedCount,
      publicationGenerationId,
      pegAnalyticsPublished: capture.pegAnalyticsPublished,
      dexGenerationId: input.dexGenerationId,
      dexGenerationLagSec: Math.max(
        0,
        input.clockSec -
          (input.inputFreshness?.dexLiquidity.updatedAt ?? input.clockSec),
      ),
      liquidityStale: input.liquidityStale,
      redemptionStale: input.redemptionStale,
      fixedInputCacheBytes: inputEntry.storedBytes,
      fixedInputUncompressedBytes: inputEntry.uncompressedBytes,
      safetyScoreIdentity,
      v9ExactSeed,
      stablecoinsCacheReadiness: {
        waitedMs: stablecoinsReadiness.waitedMs,
        pendingStartedAt: stablecoinsReadiness.pendingStartedAt,
      },
    }),
  };
}
