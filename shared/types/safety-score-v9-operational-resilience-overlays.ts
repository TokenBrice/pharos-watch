import { z } from "zod";
import { issue,
  CanonicalKeySchema,
  CanonicalTextSchema,
  NonNegativeFiniteSchema,
  StrictIsoDateSchema,
  uniqueKeyedCollectionSchema,
} from "./safety-schema-primitives";
import {
  V9OperationalResilienceIncidentSchema,
  V9OperationalResilienceLatestAssuranceSchema,
  V9OperationalResilienceReconciliationProceduresSchema,
  V9OperationalResilienceReportHistorySchema,
  V9OperationalResilienceSourceConfidenceSchema,
  V9OperationalResilienceStressEpisodeSchema,
  V9OperationalResilienceStressSettlementSchema,
} from "./safety-score-v9-operational-resilience-primitives";

const IsoDateSchema = StrictIsoDateSchema;
const UtcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Timestamp must use UTC Z notation");
const SourceIdsSchema = z
  .array(CanonicalKeySchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "Evidence source IDs must be unique");

const OperationalResilienceSourceSchema = z
  .object({
    sourceId: CanonicalKeySchema,
    label: CanonicalTextSchema,
    publisher: CanonicalTextSchema,
    publishedAt: IsoDateSchema,
    url: z.string().url(),
    confidence: V9OperationalResilienceSourceConfidenceSchema,
  })
  .strict();

const LiveHistoryEligibilitySchema = z
  .object({
    minimumLiveHistoryMonths: z.number().int().nonnegative(),
    observedAt: IsoDateSchema,
    treatment: z.literal("eligibility-only"),
    sourceIds: SourceIdsSchema,
  })
  .strict();

const RedemptionStressWindowSchema = z
  .object({
    episodeKey: CanonicalKeySchema,
    observedAt: IsoDateSchema,
    maximumWindowDays: z.number().int().positive(),
    redeemedUsdLowerBound: NonNegativeFiniteSchema,
    redeemedSupplyRatioLowerBound: NonNegativeFiniteSchema,
    settlement: V9OperationalResilienceStressSettlementSchema,
    sourceIds: SourceIdsSchema,
  })
  .strict();

const RedemptionThroughputSchema = z
  .object({
    cumulativeLifetimeRedeemedSupplyRatio: NonNegativeFiniteSchema.nullable(),
    cumulativeLifetimeRedeemedSupplyRatioSourceIds: SourceIdsSchema.optional(),
    stressWindows: z.array(RedemptionStressWindowSchema).min(1),
  })
  .strict()
  .superRefine((redemption, ctx) => {
    const hasRatio = redemption.cumulativeLifetimeRedeemedSupplyRatio !== null;
    const hasSources = redemption.cumulativeLifetimeRedeemedSupplyRatioSourceIds !== undefined;
    if (hasRatio !== hasSources) {
      issue(ctx, ["cumulativeLifetimeRedeemedSupplyRatioSourceIds"], "A cumulative redemption ratio and its evidence sources must be supplied together");
    }
  });

const StressEpisodeSchema = V9OperationalResilienceStressEpisodeSchema.extend({
  episodeKey: CanonicalKeySchema,
  sourceIds: SourceIdsSchema,
}).strict();

const ReserveReconciliationSchema = z
  .object({
    ...V9OperationalResilienceReportHistorySchema.shape,
    historySourceIds: SourceIdsSchema,
    latestAssurance: V9OperationalResilienceLatestAssuranceSchema.extend({
      sourceIds: SourceIdsSchema,
    }).strict(),
    latestReconciliationProcedures: V9OperationalResilienceReconciliationProceduresSchema.extend({
      sourceIds: SourceIdsSchema,
    }).strict(),
  })
  .strict();

const MaterialIncidentSchema = V9OperationalResilienceIncidentSchema.safeExtend({
  incidentKey: CanonicalKeySchema,
  sourceIds: SourceIdsSchema,
}).strict();

const IncidentReviewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not-reviewed") }).strict(),
  z
    .object({
      state: z.literal("reviewed"),
      windowStart: IsoDateSchema,
      windowEnd: IsoDateSchema,
      incidents: z.array(MaterialIncidentSchema),
      sourceIds: SourceIdsSchema,
    })
    .strict()
    .superRefine((review, ctx) => {
      if (review.windowEnd < review.windowStart) {
        issue(ctx, ["windowEnd"], "Incident review window cannot end before it begins");
      }
    }),
]);

function calendarMonthSpan(firstDate: string, latestDate: string): number {
  const first = new Date(`${firstDate}T00:00:00.000Z`);
  const latest = new Date(`${latestDate}T00:00:00.000Z`);
  return (latest.getUTCFullYear() - first.getUTCFullYear()) * 12 + latest.getUTCMonth() - first.getUTCMonth();
}

function collectEvidenceSourceIds(
  overlay: z.infer<typeof SafetyScoreV9OperationalResilienceOverlayShapeSchema>,
): string[] {
  const sourceIds = new Set<string>(overlay.eligibility.liveHistory.sourceIds);
  for (const sourceId of overlay.redemptionThroughput?.cumulativeLifetimeRedeemedSupplyRatioSourceIds ?? []) {
    sourceIds.add(sourceId);
  }
  for (const window of overlay.redemptionThroughput?.stressWindows ?? []) {
    window.sourceIds.forEach((sourceId) => sourceIds.add(sourceId));
  }
  for (const episode of overlay.stressEpisodes) {
    episode.sourceIds.forEach((sourceId) => sourceIds.add(sourceId));
  }
  if (overlay.reserveReconciliation !== null) {
    overlay.reserveReconciliation.historySourceIds.forEach((sourceId) => sourceIds.add(sourceId));
    overlay.reserveReconciliation.latestAssurance.sourceIds.forEach((sourceId) => sourceIds.add(sourceId));
    overlay.reserveReconciliation.latestReconciliationProcedures.sourceIds.forEach((sourceId) =>
      sourceIds.add(sourceId),
    );
  }
  if (overlay.incidentReview.state === "reviewed") {
    overlay.incidentReview.sourceIds.forEach((sourceId) => sourceIds.add(sourceId));
    for (const incident of overlay.incidentReview.incidents) {
      incident.sourceIds.forEach((sourceId) => sourceIds.add(sourceId));
    }
  }
  return [...sourceIds];
}

const SafetyScoreV9OperationalResilienceOverlayShapeSchema = z
  .object({
    assetId: CanonicalKeySchema,
    reviewedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
    reviewer: CanonicalTextSchema,
    notes: CanonicalTextSchema,
    sources: z.array(OperationalResilienceSourceSchema).min(1),
    eligibility: z
      .object({
        liveHistory: LiveHistoryEligibilitySchema,
      })
      .strict(),
    redemptionThroughput: RedemptionThroughputSchema.nullable(),
    stressEpisodes: z.array(StressEpisodeSchema),
    reserveReconciliation: ReserveReconciliationSchema.nullable(),
    incidentReview: IncidentReviewSchema,
  })
  .strict();

const SafetyScoreV9OperationalResilienceOverlaySchema =
  SafetyScoreV9OperationalResilienceOverlayShapeSchema.superRefine((overlay, ctx) => {
    const reviewedAtMs = Date.parse(overlay.reviewedAt);
    const expiresAtMs = Date.parse(overlay.expiresAt);
    if (expiresAtMs <= reviewedAtMs) {
      issue(ctx, ["expiresAt"], "Operational-resilience overlay must expire after it was reviewed");
    }

    const sourceIds = overlay.sources.map((source) => source.sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) {
      ctx.addIssue({ code: "custom", path: ["sources"], message: "Duplicate operational-resilience sourceId" });
    }
    const sourceById = new Map(overlay.sources.map((source) => [source.sourceId, source]));
    const referencedSourceIds = collectEvidenceSourceIds(overlay);
    for (const sourceId of referencedSourceIds) {
      if (!sourceById.has(sourceId)) {
        issue(ctx, ["sources"], `Unknown operational-resilience sourceId: ${sourceId}`);
      }
    }
    for (const sourceId of sourceIds) {
      if (!referencedSourceIds.includes(sourceId)) {
        issue(ctx, ["sources"], `Unused operational-resilience sourceId: ${sourceId}`);
      }
    }

    const reviewedDate = overlay.reviewedAt.slice(0, 10);
    for (const [index, source] of overlay.sources.entries()) {
      if (source.publishedAt > reviewedDate) {
        issue(ctx, ["sources", index, "publishedAt"], "Evidence source cannot post-date the review");
      }
    }
    if (overlay.eligibility.liveHistory.observedAt > reviewedDate) {
      issue(ctx, ["eligibility", "liveHistory", "observedAt"], "Live-history observation cannot post-date the review");
    }

    const episodeKeys = overlay.stressEpisodes.map((episode) => episode.episodeKey);
    if (new Set(episodeKeys).size !== episodeKeys.length) {
      ctx.addIssue({ code: "custom", path: ["stressEpisodes"], message: "Duplicate stress episodeKey" });
    }
    for (const [index, episode] of overlay.stressEpisodes.entries()) {
      if (episode.observedMonth > reviewedDate.slice(0, 7)) {
        issue(ctx, ["stressEpisodes", index, "observedMonth"], "Stress episode cannot post-date the review");
      }
    }
    const episodeKeySet = new Set(episodeKeys);
    const stressWindowKeys = overlay.redemptionThroughput?.stressWindows.map((window) => window.episodeKey) ?? [];
    if (new Set(stressWindowKeys).size !== stressWindowKeys.length) {
      issue(ctx, ["redemptionThroughput", "stressWindows"], "Duplicate redemption stress-window episodeKey");
    }
    for (const [index, window] of (overlay.redemptionThroughput?.stressWindows ?? []).entries()) {
      if (!episodeKeySet.has(window.episodeKey)) {
        issue(ctx, ["redemptionThroughput", "stressWindows", index, "episodeKey"], "Redemption stress window must reference a named stress episode");
      }
      if (window.observedAt > reviewedDate) {
        issue(ctx, ["redemptionThroughput", "stressWindows", index, "observedAt"], "Redemption observation cannot post-date the review");
      }
      if (window.settlement.state !== "unknown") {
        const requiredConfidence =
          window.settlement.verification === "issuer-reported"
            ? "issuer-reported"
            : ["independent-assurance", "audited"];
        const hasRequiredSource = window.sourceIds.some((sourceId) => {
          const confidence = sourceById.get(sourceId)?.confidence;
          return Array.isArray(requiredConfidence)
            ? confidence !== undefined && requiredConfidence.includes(confidence)
            : confidence === requiredConfidence;
        });
        if (!hasRequiredSource) {
          issue(ctx, ["redemptionThroughput", "stressWindows", index, "sourceIds"], `Settlement verification requires a ${window.settlement.verification} source`);
        }
      }
    }

    const reconciliation = overlay.reserveReconciliation;
    if (reconciliation !== null) {
      if (reconciliation.latestReportPeriodEnd > reviewedDate) {
        issue(ctx, ["reserveReconciliation", "latestReportPeriodEnd"], "Latest reserve report cannot post-date the review");
      }
      if (reconciliation.latestReportPeriodEnd < reconciliation.firstReportPeriodEnd) {
        issue(ctx, ["reserveReconciliation", "latestReportPeriodEnd"], "Latest reserve report cannot pre-date the first report");
      }
      const expectedHistoryMonths = calendarMonthSpan(
        reconciliation.firstReportPeriodEnd,
        reconciliation.latestReportPeriodEnd,
      );
      if (reconciliation.observedReportHistoryMonths !== expectedHistoryMonths) {
        issue(ctx, ["reserveReconciliation", "observedReportHistoryMonths"], `Observed report history must equal the ${expectedHistoryMonths}-month endpoint span`);
      }
      if (reconciliation.latestAssurance.periodEnd !== reconciliation.latestReportPeriodEnd) {
        issue(ctx, ["reserveReconciliation", "latestAssurance", "periodEnd"], "Latest assurance period must match the latest report period");
      }
      const assuranceConfidence =
        reconciliation.latestAssurance.level === "audit"
          ? ["audited"]
          : ["independent-assurance", "audited"];
      const hasAssuranceSource = reconciliation.latestAssurance.sourceIds.some((sourceId) => {
        const confidence = sourceById.get(sourceId)?.confidence;
        return confidence !== undefined && assuranceConfidence.includes(confidence);
      });
      if (!hasAssuranceSource) {
        issue(ctx, ["reserveReconciliation", "latestAssurance", "sourceIds"], "Latest reserve assurance must cite evidence with matching independent confidence");
      }
      if (reconciliation.continuityEvidence === "independently-verified") {
        const hasIndependentHistorySource = reconciliation.historySourceIds.some((sourceId) => {
          const confidence = sourceById.get(sourceId)?.confidence;
          return confidence === "independent-assurance" || confidence === "audited";
        });
        if (!hasIndependentHistorySource) {
          issue(ctx, ["reserveReconciliation", "historySourceIds"], "Independently verified continuity requires independent history evidence");
        }
      }
      if (reconciliation.continuityEvidence === "unknown" && reconciliation.missedMaterialPeriods !== null) {
        issue(ctx, ["reserveReconciliation", "missedMaterialPeriods"], "Unknown report continuity cannot assert a missed-period count");
      }
      if (reconciliation.missedMaterialPeriods !== null) {
        const hasMatchingContinuitySource = reconciliation.historySourceIds.some((sourceId) => {
          const confidence = sourceById.get(sourceId)?.confidence;
          return reconciliation.continuityEvidence === "issuer-reported"
            ? confidence === "issuer-reported"
            : confidence === "independent-assurance" || confidence === "audited";
        });
        if (!hasMatchingContinuitySource) {
          issue(ctx, ["reserveReconciliation", "historySourceIds"], "A missed-period count requires evidence matching the asserted continuity confidence");
        }
      }
      const claimsReconciliationProcedure =
        reconciliation.latestReconciliationProcedures.bankAndDepositaryBalances === true ||
        reconciliation.latestReconciliationProcedures.blockchainAssetsAndLiabilities === true;
      const hasIndependentProcedureSource =
        claimsReconciliationProcedure &&
        reconciliation.latestReconciliationProcedures.sourceIds.some((sourceId) => {
          const confidence = sourceById.get(sourceId)?.confidence;
          return confidence === "independent-assurance" || confidence === "audited";
        });
      if (claimsReconciliationProcedure && !hasIndependentProcedureSource) {
        issue(ctx, ["reserveReconciliation", "latestReconciliationProcedures", "sourceIds"], "Observed reserve-reconciliation procedures require independent assurance evidence");
      }
    }

    if (overlay.incidentReview.state === "reviewed") {
      if (overlay.incidentReview.windowEnd > reviewedDate) {
        issue(ctx, ["incidentReview", "windowEnd"], "Incident review window cannot post-date the review");
      }
      for (const [index, incident] of overlay.incidentReview.incidents.entries()) {
        if (
          incident.occurredAt < overlay.incidentReview.windowStart ||
          incident.occurredAt > overlay.incidentReview.windowEnd
        ) {
          issue(ctx, ["incidentReview", "incidents", index, "occurredAt"], "Incident must occur within the reviewed window");
        }
        if (incident.resolvedAt !== null && incident.resolvedAt > reviewedDate) {
          issue(ctx, ["incidentReview", "incidents", index, "resolvedAt"], "Incident resolution cannot post-date the review");
        }
      }
    }
  });

export const SafetyScoreV9OperationalResilienceOverlayFileSchema = uniqueKeyedCollectionSchema({
  itemSchema: SafetyScoreV9OperationalResilienceOverlaySchema,
  collectionKey: "overlays",
  duplicateMessage: "Duplicate operational-resilience overlay assetId",
  noteSchema: CanonicalTextSchema,
});
