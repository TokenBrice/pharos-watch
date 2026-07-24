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
  buildSafetyScoreV9FixedInputCacheEntry,
  normalizeFixedInput,
} from "../lib/report-cards-fixed-input";
import { recordCronFailure } from "../lib/cron-logger";
import { runSafetyScoreV9ShadowAfterV8Publication } from "../lib/safety-score-v9-shadow-runner";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { enrichSafetyScoreV9FixedInputSupplyWithEvidence } from "../lib/safety-score-v9-supply-attribution";
import { loadReportCardEvidenceJournalByIdV1 } from "../lib/report-card-evidence-journal-store";
import {
  appendSupplyAttributionJournalV1,
  loadSupplyAttributionJournalByIdV1,
} from "../lib/safety-score-v9-supply-attribution-journal-store";
import { captureSafetyScoreV9PegProvenanceById } from "../lib/safety-score-v9-peg-provenance";

export async function publishReportCardCache(
  db: D1Database,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
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
  await setCacheMany(db, [snapshotEntry, compactEntry, alertEntry, fixedInputEntry], signal);

  let v9Shadow: Record<string, unknown>;
  let v9FixedInputCacheBytes: number | null = null;
  let v9FixedInputUncompressedBytes: number | null = null;
  try {
    v9Shadow = await runSafetyScoreV9ShadowAfterV8Publication({
      db,
      fixedInput,
      prepareFixedInput: async (baseFixedInput, shadowSignal) => {
        const supplyCapture = await enrichSafetyScoreV9FixedInputSupplyWithEvidence(
          baseFixedInput,
          chainRpcs,
          shadowSignal,
        );
        const supplyFixedInput = supplyCapture.fixedInput;
        const [evidenceJournalById, supplyAttributionJournalById] =
          await Promise.all([
            loadReportCardEvidenceJournalByIdV1(
              db,
              supplyFixedInput.activeAssetIds,
              supplyFixedInput.clockSec,
              shadowSignal,
            ),
            loadSupplyAttributionJournalByIdV1(
              db,
              ["wm-m0", "xaut-tether"].filter((assetId) =>
                supplyFixedInput.activeAssetIds.includes(assetId),
              ),
              supplyFixedInput.clockSec,
              shadowSignal,
            ),
          ]);
        if (supplyCapture.journalRecords.length > 0) {
          const journalNowSec = Math.max(
            Math.floor(Date.now() / 1_000),
            ...supplyCapture.journalRecords.map((record) => record.completedAtSec),
          );
          await appendSupplyAttributionJournalV1(
            db,
            supplyCapture.journalRecords,
            journalNowSec,
            shadowSignal,
          );
        }
        if (!v9PegProvenanceSource) {
          throw new Error("Report-card publication did not retain its ephemeral V9 peg evidence source");
        }
        const pegProvenanceById = captureSafetyScoreV9PegProvenanceById(
          supplyFixedInput,
          v9PegProvenanceSource,
        );
        const v9FixedInput = normalizeFixedInput({
          ...supplyFixedInput,
          evidenceJournalById,
          supplyAttributionJournalById,
          pegProvenanceById,
        });
        const v9FixedInputEntry = await buildSafetyScoreV9FixedInputCacheEntry(
          v9FixedInput,
          safetyScoreIdentity,
        );
        await setCacheMany(db, [v9FixedInputEntry], shadowSignal);
        v9FixedInputCacheBytes = v9FixedInputEntry.storedBytes;
        v9FixedInputUncompressedBytes = v9FixedInputEntry.uncompressedBytes;
        return v9FixedInput;
      },
      v8Cards: publication.activeCards,
      v8Publication: publication.completeness,
      v8MethodologyVersion: snapshot.methodology.version,
      signal,
    });
  } catch (error) {
    const failure = recordCronFailure("publish-report-card-cache:v9-shadow", error, {
      metadata: {
        v8PublicationGenerationId: publication.completeness.generationId,
        baseInputGenerationId: fixedInput.baseInputGenerationId,
      },
    });
    v9Shadow = {
      status: "failed",
      stage: "scheduler",
      code: failure.errorName,
      message: failure.errorMessage,
    };
  }

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
      v9FixedInputCacheBytes,
      v9FixedInputUncompressedBytes,
      safetyScoreIdentity,
      v9Shadow,
    }),
  };
}
