import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { setCacheMany } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { buildReportCardPublicationPlan } from "../lib/report-card-publication";
import {
  buildReportCardsFixedInputCacheEntry,
} from "../lib/report-cards-fixed-input";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import {
  buildSafetyScoreV9PegProvenanceSeedCacheEntry,
  captureSafetyScoreV9PegProvenanceById,
} from "../lib/safety-score-v9-peg-provenance";

export async function prepareSafetyScoreV9Input(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);

  const snapshot = await buildReportCardsSnapshot(db, {
    publishPegAnalytics: true,
    captureFixedInput: true,
  });

  throwIfAborted(signal);

  const publication = buildReportCardPublicationPlan(snapshot.cards, snapshot.methodology.version, snapshot.updatedAt);
  const {
    fixedInput,
    v9PegProvenanceSource,
  } = snapshot;
  if (!fixedInput) {
    throw new Error("Report-card publication did not produce its exact fixed-input artifact");
  }
  if (fixedInput.sourceGeneration !== publication.completeness.generationId) {
    throw new Error(
      `Report-card fixed-input generation ${fixedInput.sourceGeneration} does not match publication ${publication.completeness.generationId}`,
    );
  }
  const safetyScoreIdentity = buildSafetyScoreV9InputIdentity({
    methodologyVersion: snapshot.methodology.version,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    publicationGenerationId: publication.completeness.generationId,
  });
  const fixedInputEntry = await buildReportCardsFixedInputCacheEntry(fixedInput, safetyScoreIdentity);
  let v9SeedEntry:
    ReturnType<typeof buildSafetyScoreV9PegProvenanceSeedCacheEntry> | null =
    null;
  let v9ExactSeed: Record<string, unknown>;
  try {
    if (!v9PegProvenanceSource) {
      throw new Error(
        "Report-card publication did not retain its ephemeral V9 peg evidence source",
      );
    }
    const pegProvenanceById =
      captureSafetyScoreV9PegProvenanceById(
        fixedInput,
        v9PegProvenanceSource,
      );
    v9SeedEntry = buildSafetyScoreV9PegProvenanceSeedCacheEntry({
      sourceGeneration: fixedInput.sourceGeneration,
      clockSec: fixedInput.clockSec,
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
      fixedInputEntry,
      ...(v9SeedEntry ? [v9SeedEntry] : []),
    ],
    signal,
  );

  return {
    itemCount: publication.completeness.expectedCount,
    productivity: {
      productive: true,
      reason: "safety-score-v9-input-published",
    },
    metadata: JSON.stringify({
      updatedAt: snapshot.updatedAt,
      snapshotCards: snapshot.cards.length,
      activeCards: publication.completeness.expectedCount,
      scoredCards: publication.completeness.scoredCount,
      notRatedCards: publication.completeness.notRatedCount,
      publicationGenerationId: publication.completeness.generationId,
      liquidityStale: snapshot.liquidityStale,
      redemptionStale: snapshot.redemptionStale,
      fixedInputCacheBytes: fixedInputEntry.storedBytes,
      fixedInputUncompressedBytes: fixedInputEntry.uncompressedBytes,
      safetyScoreIdentity,
      v9ExactSeed,
    }),
  };
}
