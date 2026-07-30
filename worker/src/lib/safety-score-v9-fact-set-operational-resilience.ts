import { createV9EvidenceReference } from "@shared/lib/safety-score-v9/evidence";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import {
  V9OperationalResilienceFactSchema,
  type V9OperationalResilienceClaimConfidence,
  type V9OperationalResilienceFact,
} from "@shared/types/safety-score-v9-operational-resilience";
import type { SafetyScoreV9OperationalResilienceOverlay } from "./safety-score-v9-extension-operational-resilience";
import {
  addEvidence,
  isoDateStartSec,
  timestampSec,
  type AssetBuildContext,
} from "./safety-score-v9-fact-set-context";

function operationalResilienceConfidence(
  overlay: SafetyScoreV9OperationalResilienceOverlay,
  sourceIds: readonly string[],
): V9OperationalResilienceClaimConfidence {
  const confidenceRank: Record<Exclude<V9OperationalResilienceClaimConfidence, "unknown">, number> = {
    "issuer-reported": 0,
    "independent-assurance": 1,
    audited: 2,
  };
  const sourceById = new Map(overlay.sources.map((source) => [source.sourceId, source]));
  const confidences = sourceIds.map((sourceId) => {
    const source = sourceById.get(sourceId);
    if (!source) throw new Error(`Unknown operational-resilience source ${overlay.assetId}:${sourceId}`);
    return source.confidence;
  });
  if (confidences.length === 0) {
    throw new Error(`Operational-resilience claim ${overlay.assetId} has no evidence sources`);
  }
  return confidences.reduce((lowest, confidence) =>
    confidenceRank[confidence] < confidenceRank[lowest] ? confidence : lowest,
  );
}

export function buildOperationalResilienceFact(context: AssetBuildContext): V9OperationalResilienceFact | null {
  const overlay = context.asset.operationalResilience ?? null;
  if (overlay === null) return null;
  const sourceGenerationId = context.extension.sources.researchOverlays.generationId;
  const evidenceIdBySourceId = new Map(
    overlay.sources.map((source) => {
      const publishedAtSec = isoDateStartSec(
        source.publishedAt,
        `${overlay.assetId}:${source.sourceId} publication`,
        context.fixedInput.clockSec,
      );
      const evidenceId = addEvidence(
        context,
        createV9EvidenceReference(
          {
            evidenceId: `${overlay.assetId}:operational-resilience:${source.sourceId}`,
            sourceId: source.sourceId,
            sourceGenerationId,
            disposition: "published",
            observedAtSec: publishedAtSec,
            publishedAtSec,
            url: source.url,
            contentSha256: domainDigest("safety-score-v9.operational-resilience-source.v1", {
              assetId: overlay.assetId,
              source,
            }),
            maxAgeSec: null,
          },
          context.fixedInput.clockSec,
        ),
      );
      return [source.sourceId, evidenceId] as const;
    }),
  );
  const evidenceRefIds = (sourceIds: readonly string[]): string[] =>
    sourceIds.map((sourceId) => {
      const evidenceId = evidenceIdBySourceId.get(sourceId);
      if (!evidenceId) throw new Error(`Unknown operational-resilience source ${overlay.assetId}:${sourceId}`);
      return evidenceId;
    });
  const claimEvidence = (sourceIds: readonly string[]) => ({
    evidenceRefIds: evidenceRefIds(sourceIds),
    confidence: operationalResilienceConfidence(overlay, sourceIds),
  });

  const cumulativeRatio = overlay.redemptionThroughput?.cumulativeLifetimeRedeemedSupplyRatio ?? null;
  const cumulativeSourceIds =
    overlay.redemptionThroughput?.cumulativeLifetimeRedeemedSupplyRatioSourceIds ?? null;
  if ((cumulativeRatio === null) !== (cumulativeSourceIds === null)) {
    throw new Error(`Operational-resilience cumulative redemption claim ${overlay.assetId} lacks exact evidence`);
  }
  const reconciliation = overlay.reserveReconciliation;
  const incidentReview = overlay.incidentReview;
  return V9OperationalResilienceFactSchema.parse({
    schemaVersion: 1,
    reviewedAtSec: timestampSec(
      overlay.reviewedAt,
      `${overlay.assetId} operational-resilience review`,
      context.fixedInput.clockSec,
    ),
    expiresAtSec: Math.floor(Date.parse(overlay.expiresAt) / 1_000),
    liveHistoryEligibility: {
      minimumLiveHistoryMonths: overlay.eligibility.liveHistory.minimumLiveHistoryMonths,
      observedAtSec: isoDateStartSec(
        overlay.eligibility.liveHistory.observedAt,
        `${overlay.assetId} live-history observation`,
        context.fixedInput.clockSec,
      ),
      treatment: "eligibility-only",
      ...claimEvidence(overlay.eligibility.liveHistory.sourceIds),
    },
    redemptionThroughput:
      overlay.redemptionThroughput === null
        ? null
        : {
            cumulativeLifetimeRedeemedSupplyRatio:
              cumulativeRatio === null || cumulativeSourceIds === null
                ? null
                : {
                    value: cumulativeRatio,
                    ...claimEvidence(cumulativeSourceIds),
                  },
            stressWindows: overlay.redemptionThroughput.stressWindows.map((window) => ({
              episodeKey: window.episodeKey,
              observedAtSec: isoDateStartSec(
                window.observedAt,
                `${overlay.assetId}:${window.episodeKey} redemption observation`,
                context.fixedInput.clockSec,
              ),
              maximumWindowDays: window.maximumWindowDays,
              redeemedUsdLowerBound: window.redeemedUsdLowerBound,
              redeemedSupplyRatioLowerBound: window.redeemedSupplyRatioLowerBound,
              settlement: window.settlement,
              ...claimEvidence(window.sourceIds),
            })),
          },
    stressEpisodes: overlay.stressEpisodes.map((episode) => ({
      episodeKey: episode.episodeKey,
      name: episode.name,
      observedMonth: episode.observedMonth,
      redemptionContinued: episode.redemptionContinued,
      recoveredWithinSec: episode.recoveredWithinSec,
      ...claimEvidence(episode.sourceIds),
    })),
    reserveReconciliation:
      reconciliation === null
        ? null
        : {
            reportHistory: {
              firstReportPeriodEnd: reconciliation.firstReportPeriodEnd,
              latestReportPeriodEnd: reconciliation.latestReportPeriodEnd,
              observedReportHistoryMonths: reconciliation.observedReportHistoryMonths,
              reportedCadence: reconciliation.reportedCadence,
              continuityEvidence: reconciliation.continuityEvidence,
              missedMaterialPeriods: reconciliation.missedMaterialPeriods,
              ...claimEvidence(reconciliation.historySourceIds),
              ...(reconciliation.continuityEvidence === "unknown" ? { confidence: "unknown" as const } : {}),
            },
            latestAssurance: {
              level: reconciliation.latestAssurance.level,
              standard: reconciliation.latestAssurance.standard,
              periodEnd: reconciliation.latestAssurance.periodEnd,
              ...claimEvidence(reconciliation.latestAssurance.sourceIds),
            },
            latestReconciliationProcedures: {
              bankAndDepositaryBalances:
                reconciliation.latestReconciliationProcedures.bankAndDepositaryBalances,
              blockchainAssetsAndLiabilities:
                reconciliation.latestReconciliationProcedures.blockchainAssetsAndLiabilities,
              ...claimEvidence(reconciliation.latestReconciliationProcedures.sourceIds),
            },
          },
    incidentReview:
      incidentReview.state === "not-reviewed"
        ? { state: "not-reviewed" }
        : {
            state: "reviewed",
            windowStart: incidentReview.windowStart,
            windowEnd: incidentReview.windowEnd,
            incidents: incidentReview.incidents.map((incident) => ({
              incidentKey: incident.incidentKey,
              name: incident.name,
              category: incident.category,
              state: incident.state,
              occurredAt: incident.occurredAt,
              resolvedAt: incident.resolvedAt,
              ...claimEvidence(incident.sourceIds),
            })),
            ...claimEvidence(incidentReview.sourceIds),
          },
  });
}
