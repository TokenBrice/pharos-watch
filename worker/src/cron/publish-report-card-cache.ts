import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { ALERT_SAFETY_SOURCE_CACHE_KEY, buildAlertSafetySourceEnvelope } from "../lib/alert-safety-source-cache";
import { setCacheMany } from "../lib/db-cache";
import { buildReportCardCacheEntry } from "../lib/report-card-cache";
import { buildPublishedReportCardsSnapshotCacheEntry } from "../lib/report-cards-snapshot-cache";
import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { buildReportCardPublicationPlan } from "../lib/report-card-publication";
import { buildReportCardsFixedInputCacheEntry } from "../lib/report-cards-fixed-input";

export async function publishReportCardCache(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);

  const snapshot = await buildReportCardsSnapshot(db, {
    publishPegAnalytics: true,
    captureFixedInput: true,
  });

  throwIfAborted(signal);

  const publication = buildReportCardPublicationPlan(snapshot.cards, snapshot.methodology.version, snapshot.updatedAt);
  const { fixedInput, ...publicSnapshot } = snapshot;
  const publishedSnapshot = {
    ...publicSnapshot,
    publication: publication.completeness,
  };
  if (!fixedInput) {
    throw new Error("Report-card publication did not produce its exact fixed-input artifact");
  }
  if (fixedInput.sourceGeneration !== publication.completeness.generationId) {
    throw new Error(
      `Report-card fixed-input generation ${fixedInput.sourceGeneration} does not match publication ${publication.completeness.generationId}`,
    );
  }
  const fixedInputEntry = await buildReportCardsFixedInputCacheEntry(fixedInput);
  const compactEntry = buildReportCardCacheEntry(publication.activeCards, snapshot.updatedAt, {
    liquidityStale: snapshot.liquidityStale,
    redemptionStale: snapshot.redemptionStale,
    inputFreshness: snapshot.inputFreshness,
    completeness: publication.completeness,
  });
  const alertEntry = {
    key: ALERT_SAFETY_SOURCE_CACHE_KEY,
    value: JSON.stringify(
      buildAlertSafetySourceEnvelope(
        publication.activeCards,
        snapshot.methodology.version,
        snapshot.updatedAt,
        publication.completeness,
      ),
    ),
  };
  await setCacheMany(
    db,
    [buildPublishedReportCardsSnapshotCacheEntry(publishedSnapshot), compactEntry, alertEntry, fixedInputEntry],
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
      fixedInputCacheBytes: fixedInputEntry.storedBytes,
      fixedInputUncompressedBytes: fixedInputEntry.uncompressedBytes,
    }),
  };
}
