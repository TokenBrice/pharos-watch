import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { ALERT_SAFETY_SOURCE_CACHE_KEY, buildAlertSafetySourceEnvelope } from "../lib/alert-safety-source-cache";
import { setCacheMany } from "../lib/db-cache";
import { buildReportCardCacheEntry } from "../lib/report-card-cache";
import { buildPublishedReportCardsSnapshotCacheEntry } from "../lib/report-cards-snapshot-cache";
import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { buildReportCardPublicationPlan } from "../lib/report-card-publication";
import {
  buildReportCardsFixedInputCacheEntry,
} from "../lib/report-cards-fixed-input";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import {
  buildSafetyScoreV9PegProvenanceSeedCacheEntry,
  captureSafetyScoreV9PegProvenanceById,
} from "../lib/safety-score-v9-peg-provenance";

export async function publishReportCardCache(
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
    ...publicSnapshot
  } = snapshot;
  if (!fixedInput) {
    throw new Error("Report-card publication did not produce its exact fixed-input artifact");
  }
  if (fixedInput.sourceGeneration !== publication.completeness.generationId) {
    throw new Error(
      `Report-card fixed-input generation ${fixedInput.sourceGeneration} does not match publication ${publication.completeness.generationId}`,
    );
  }
  const safetyScoreIdentity = buildSafetyScoreV8PublicationIdentity({
    methodologyVersion: snapshot.methodology.version,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    publicationGenerationId: publication.completeness.generationId,
  });
  const publishedSnapshot = {
    ...publicSnapshot,
    safetyScoreIdentity,
    publication: publication.completeness,
  };
  const fixedInputEntry = await buildReportCardsFixedInputCacheEntry(fixedInput, safetyScoreIdentity);
  const compactEntry = buildReportCardCacheEntry(publication.activeCards, snapshot.updatedAt, {
    liquidityStale: snapshot.liquidityStale,
    redemptionStale: snapshot.redemptionStale,
    inputFreshness: snapshot.inputFreshness,
    completeness: publication.completeness,
    safetyScoreIdentity,
  });
  const alertEntry = {
    key: ALERT_SAFETY_SOURCE_CACHE_KEY,
    value: JSON.stringify(
      buildAlertSafetySourceEnvelope(
        publication.activeCards,
        snapshot.methodology.version,
        snapshot.updatedAt,
        publication.completeness,
        safetyScoreIdentity,
      ),
    ),
  };
  const snapshotEntry = await buildPublishedReportCardsSnapshotCacheEntry(publishedSnapshot);
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
      snapshotEntry,
      compactEntry,
      alertEntry,
      fixedInputEntry,
      ...(v9SeedEntry ? [v9SeedEntry] : []),
    ],
    signal,
  );

  return {
    itemCount: publication.completeness.expectedCount,
    productivity: {
      productive: true,
      reason: "report-card-cache-published",
      publications: [
        {
          surface: "report-card-cache",
          generationId: publication.completeness.generationId,
          publishedAt: snapshot.updatedAt,
          candidateRows: publication.completeness.expectedCount,
          publishedRows: publication.completeness.expectedCount,
          expectedRows: publication.completeness.expectedCount,
          artifactCacheKey: "report_card_cache",
          validationSummary: {
            methodologyVersion: snapshot.methodology.version,
            scoredCount: publication.completeness.scoredCount,
            notRatedCount: publication.completeness.notRatedCount,
            safetyScoreIdentity,
          },
        },
      ],
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
      snapshotCacheBytes: snapshotEntry.storedBytes,
      snapshotCacheUncompressedBytes: snapshotEntry.uncompressedBytes,
      fixedInputCacheBytes: fixedInputEntry.storedBytes,
      fixedInputUncompressedBytes: fixedInputEntry.uncompressedBytes,
      safetyScoreIdentity,
      v9ExactSeed,
    }),
  };
}
