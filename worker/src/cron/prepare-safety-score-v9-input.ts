import { setCacheMany } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { buildNativeSafetyScoreV9Capture } from "../lib/safety-score-v9-capture";
import { buildNativeV9InputCacheEntry } from "../lib/safety-score-v9-native-input";
import {
  buildSafetyScoreV9PegProvenanceSeedCacheEntry,
  captureSafetyScoreV9PegProvenanceById,
} from "../lib/safety-score-v9-peg-provenance";

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

  const capture = await buildNativeSafetyScoreV9Capture(db, {
    ...(expectedDexGenerationId === undefined ? {} : { expectedDexGenerationId }),
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
    }),
  };
}
