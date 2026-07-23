import operationalResilienceOverlaysAsset from "@shared/data/safety-score-v9/operational-resilience-overlays-v1.json";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { z } from "zod";

const CanonicalTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");
const CanonicalKeySchema = CanonicalTextSchema.refine(
  (value) => /^[a-z0-9][a-z0-9._:-]*$/.test(value),
  "Value must be a canonical lowercase identifier",
);
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Value must be a valid ISO calendar date");
const UtcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Timestamp must use UTC Z notation");
const SourceIdsSchema = z
  .array(CanonicalKeySchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "Evidence source IDs must be unique");
const NonNegativeFiniteSchema = z.number().finite().nonnegative();

export const SafetyScoreV9OperationalResilienceSourceConfidenceSchema = z.enum([
  "issuer-reported",
  "independent-assurance",
  "audited",
]);

const OperationalResilienceSourceSchema = z
  .object({
    sourceId: CanonicalKeySchema,
    label: CanonicalTextSchema,
    publisher: CanonicalTextSchema,
    publishedAt: IsoDateSchema,
    url: z.string().url(),
    confidence: SafetyScoreV9OperationalResilienceSourceConfidenceSchema,
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

const StressSettlementSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.enum(["settled-in-full", "not-settled-in-full"]),
      verification: z.enum(["issuer-reported", "independently-verified"]),
    })
    .strict(),
  z.object({ state: z.literal("unknown") }).strict(),
]);

const RedemptionStressWindowSchema = z
  .object({
    episodeKey: CanonicalKeySchema,
    observedAt: IsoDateSchema,
    maximumWindowDays: z.number().int().positive(),
    redeemedUsdLowerBound: NonNegativeFiniteSchema,
    redeemedSupplyRatioLowerBound: NonNegativeFiniteSchema,
    settlement: StressSettlementSchema,
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
      ctx.addIssue({
        code: "custom",
        path: ["cumulativeLifetimeRedeemedSupplyRatioSourceIds"],
        message: "A cumulative redemption ratio and its evidence sources must be supplied together",
      });
    }
  });

const StressEpisodeSchema = z
  .object({
    episodeKey: CanonicalKeySchema,
    name: CanonicalTextSchema,
    observedMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    redemptionContinued: z.boolean().nullable(),
    recoveredWithinSec: NonNegativeFiniteSchema.nullable(),
    sourceIds: SourceIdsSchema,
  })
  .strict();

const ReserveReconciliationSchema = z
  .object({
    firstReportPeriodEnd: IsoDateSchema,
    latestReportPeriodEnd: IsoDateSchema,
    observedReportHistoryMonths: z.number().int().nonnegative(),
    reportedCadence: z.enum(["monthly", "quarterly", "semi-annual", "annual", "ad-hoc"]),
    continuityEvidence: z.enum(["issuer-reported", "independently-verified", "unknown"]),
    missedMaterialPeriods: z.number().int().nonnegative().nullable(),
    historySourceIds: SourceIdsSchema,
    latestAssurance: z
      .object({
        level: z.enum(["limited-assurance", "reasonable-assurance", "audit"]),
        standard: CanonicalTextSchema,
        periodEnd: IsoDateSchema,
        sourceIds: SourceIdsSchema,
      })
      .strict(),
    latestReconciliationProcedures: z
      .object({
        bankAndDepositaryBalances: z.boolean().nullable(),
        blockchainAssetsAndLiabilities: z.boolean().nullable(),
        sourceIds: SourceIdsSchema,
      })
      .strict(),
  })
  .strict();

const MaterialIncidentSchema = z
  .object({
    incidentKey: CanonicalKeySchema,
    name: CanonicalTextSchema,
    category: z.enum(["redemption", "reserve", "custody", "control", "assurance"]),
    state: z.enum(["active", "resolved"]),
    occurredAt: IsoDateSchema,
    resolvedAt: IsoDateSchema.nullable(),
    sourceIds: SourceIdsSchema,
  })
  .strict()
  .superRefine((incident, ctx) => {
    if (incident.state === "active" && incident.resolvedAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "An active incident cannot have a resolution date",
      });
    }
    if (incident.state === "resolved" && incident.resolvedAt === null) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "A resolved incident requires a resolution date",
      });
    }
    if (incident.resolvedAt !== null && incident.resolvedAt < incident.occurredAt) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "An incident cannot resolve before it occurred",
      });
    }
  });

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
        ctx.addIssue({
          code: "custom",
          path: ["windowEnd"],
          message: "Incident review window cannot end before it begins",
        });
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

export const SafetyScoreV9OperationalResilienceOverlaySchema =
  SafetyScoreV9OperationalResilienceOverlayShapeSchema.superRefine((overlay, ctx) => {
    const reviewedAtMs = Date.parse(overlay.reviewedAt);
    const expiresAtMs = Date.parse(overlay.expiresAt);
    if (expiresAtMs <= reviewedAtMs) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Operational-resilience overlay must expire after it was reviewed",
      });
    }

    const sourceIds = overlay.sources.map((source) => source.sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) {
      ctx.addIssue({ code: "custom", path: ["sources"], message: "Duplicate operational-resilience sourceId" });
    }
    const sourceById = new Map(overlay.sources.map((source) => [source.sourceId, source]));
    const referencedSourceIds = collectEvidenceSourceIds(overlay);
    for (const sourceId of referencedSourceIds) {
      if (!sourceById.has(sourceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources"],
          message: `Unknown operational-resilience sourceId: ${sourceId}`,
        });
      }
    }
    for (const sourceId of sourceIds) {
      if (!referencedSourceIds.includes(sourceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources"],
          message: `Unused operational-resilience sourceId: ${sourceId}`,
        });
      }
    }

    const reviewedDate = overlay.reviewedAt.slice(0, 10);
    for (const [index, source] of overlay.sources.entries()) {
      if (source.publishedAt > reviewedDate) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", index, "publishedAt"],
          message: "Evidence source cannot post-date the review",
        });
      }
    }
    if (overlay.eligibility.liveHistory.observedAt > reviewedDate) {
      ctx.addIssue({
        code: "custom",
        path: ["eligibility", "liveHistory", "observedAt"],
        message: "Live-history observation cannot post-date the review",
      });
    }

    const episodeKeys = overlay.stressEpisodes.map((episode) => episode.episodeKey);
    if (new Set(episodeKeys).size !== episodeKeys.length) {
      ctx.addIssue({ code: "custom", path: ["stressEpisodes"], message: "Duplicate stress episodeKey" });
    }
    for (const [index, episode] of overlay.stressEpisodes.entries()) {
      if (episode.observedMonth > reviewedDate.slice(0, 7)) {
        ctx.addIssue({
          code: "custom",
          path: ["stressEpisodes", index, "observedMonth"],
          message: "Stress episode cannot post-date the review",
        });
      }
    }
    const episodeKeySet = new Set(episodeKeys);
    const stressWindowKeys = overlay.redemptionThroughput?.stressWindows.map((window) => window.episodeKey) ?? [];
    if (new Set(stressWindowKeys).size !== stressWindowKeys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["redemptionThroughput", "stressWindows"],
        message: "Duplicate redemption stress-window episodeKey",
      });
    }
    for (const [index, window] of (overlay.redemptionThroughput?.stressWindows ?? []).entries()) {
      if (!episodeKeySet.has(window.episodeKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["redemptionThroughput", "stressWindows", index, "episodeKey"],
          message: "Redemption stress window must reference a named stress episode",
        });
      }
      if (window.observedAt > reviewedDate) {
        ctx.addIssue({
          code: "custom",
          path: ["redemptionThroughput", "stressWindows", index, "observedAt"],
          message: "Redemption observation cannot post-date the review",
        });
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
          ctx.addIssue({
            code: "custom",
            path: ["redemptionThroughput", "stressWindows", index, "sourceIds"],
            message: `Settlement verification requires a ${window.settlement.verification} source`,
          });
        }
      }
    }

    const reconciliation = overlay.reserveReconciliation;
    if (reconciliation !== null) {
      if (reconciliation.latestReportPeriodEnd > reviewedDate) {
        ctx.addIssue({
          code: "custom",
          path: ["reserveReconciliation", "latestReportPeriodEnd"],
          message: "Latest reserve report cannot post-date the review",
        });
      }
      if (reconciliation.latestReportPeriodEnd < reconciliation.firstReportPeriodEnd) {
        ctx.addIssue({
          code: "custom",
          path: ["reserveReconciliation", "latestReportPeriodEnd"],
          message: "Latest reserve report cannot pre-date the first report",
        });
      }
      const expectedHistoryMonths = calendarMonthSpan(
        reconciliation.firstReportPeriodEnd,
        reconciliation.latestReportPeriodEnd,
      );
      if (reconciliation.observedReportHistoryMonths !== expectedHistoryMonths) {
        ctx.addIssue({
          code: "custom",
          path: ["reserveReconciliation", "observedReportHistoryMonths"],
          message: `Observed report history must equal the ${expectedHistoryMonths}-month endpoint span`,
        });
      }
      if (reconciliation.latestAssurance.periodEnd !== reconciliation.latestReportPeriodEnd) {
        ctx.addIssue({
          code: "custom",
          path: ["reserveReconciliation", "latestAssurance", "periodEnd"],
          message: "Latest assurance period must match the latest report period",
        });
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
        ctx.addIssue({
          code: "custom",
          path: ["reserveReconciliation", "latestAssurance", "sourceIds"],
          message: "Latest reserve assurance must cite evidence with matching independent confidence",
        });
      }
      if (reconciliation.continuityEvidence === "independently-verified") {
        const hasIndependentHistorySource = reconciliation.historySourceIds.some((sourceId) => {
          const confidence = sourceById.get(sourceId)?.confidence;
          return confidence === "independent-assurance" || confidence === "audited";
        });
        if (!hasIndependentHistorySource) {
          ctx.addIssue({
            code: "custom",
            path: ["reserveReconciliation", "historySourceIds"],
            message: "Independently verified continuity requires independent history evidence",
          });
        }
      }
      if (reconciliation.continuityEvidence === "unknown" && reconciliation.missedMaterialPeriods !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["reserveReconciliation", "missedMaterialPeriods"],
          message: "Unknown report continuity cannot assert a missed-period count",
        });
      }
      if (reconciliation.missedMaterialPeriods !== null) {
        const hasMatchingContinuitySource = reconciliation.historySourceIds.some((sourceId) => {
          const confidence = sourceById.get(sourceId)?.confidence;
          return reconciliation.continuityEvidence === "issuer-reported"
            ? confidence === "issuer-reported"
            : confidence === "independent-assurance" || confidence === "audited";
        });
        if (!hasMatchingContinuitySource) {
          ctx.addIssue({
            code: "custom",
            path: ["reserveReconciliation", "historySourceIds"],
            message: "A missed-period count requires evidence matching the asserted continuity confidence",
          });
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
        ctx.addIssue({
          code: "custom",
          path: ["reserveReconciliation", "latestReconciliationProcedures", "sourceIds"],
          message: "Observed reserve-reconciliation procedures require independent assurance evidence",
        });
      }
    }

    if (overlay.incidentReview.state === "reviewed") {
      if (overlay.incidentReview.windowEnd > reviewedDate) {
        ctx.addIssue({
          code: "custom",
          path: ["incidentReview", "windowEnd"],
          message: "Incident review window cannot post-date the review",
        });
      }
      for (const [index, incident] of overlay.incidentReview.incidents.entries()) {
        if (
          incident.occurredAt < overlay.incidentReview.windowStart ||
          incident.occurredAt > overlay.incidentReview.windowEnd
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["incidentReview", "incidents", index, "occurredAt"],
            message: "Incident must occur within the reviewed window",
          });
        }
        if (incident.resolvedAt !== null && incident.resolvedAt > reviewedDate) {
          ctx.addIssue({
            code: "custom",
            path: ["incidentReview", "incidents", index, "resolvedAt"],
            message: "Incident resolution cannot post-date the review",
          });
        }
      }
    }
  });

export const SafetyScoreV9OperationalResilienceOverlayFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    note: CanonicalTextSchema,
    overlays: z.array(SafetyScoreV9OperationalResilienceOverlaySchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const assetIds = file.overlays.map((overlay) => overlay.assetId);
    if (new Set(assetIds).size !== assetIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["overlays"],
        message: "Duplicate operational-resilience overlay assetId",
      });
    }
  });

export type SafetyScoreV9OperationalResilienceOverlay = z.infer<
  typeof SafetyScoreV9OperationalResilienceOverlaySchema
>;

const OPERATIONAL_RESILIENCE_OVERLAY_FILE = SafetyScoreV9OperationalResilienceOverlayFileSchema.parse(
  operationalResilienceOverlaysAsset,
);

export const SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST = sha256Hex(
  stableJsonStringifyV1({
    domain: "safety-score-v9.operational-resilience-overlays.v1",
    payload: OPERATIONAL_RESILIENCE_OVERLAY_FILE,
  }),
);

export const SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS: ReadonlyMap<
  string,
  SafetyScoreV9OperationalResilienceOverlay
> = new Map(OPERATIONAL_RESILIENCE_OVERLAY_FILE.overlays.map((overlay) => [overlay.assetId, overlay]));

export function getSafetyScoreV9OperationalResilienceOverlay(
  assetId: string,
  clockSec: number,
): SafetyScoreV9OperationalResilienceOverlay | null {
  if (!Number.isFinite(clockSec) || clockSec < 0) {
    throw new Error("Safety Score v9 operational-resilience clock must be finite and non-negative");
  }
  const overlay = SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS.get(assetId);
  if (!overlay) return null;
  const clockMs = clockSec * 1_000;
  return Date.parse(overlay.reviewedAt) <= clockMs && clockMs < Date.parse(overlay.expiresAt) ? overlay : null;
}

export function getSafetyScoreV9OperationalResilienceOverlayEvidence(
  assetId: string,
  clockSec: number,
): {
  reviewedAt: string;
  expiresAt: string;
  sources: SafetyScoreV9OperationalResilienceOverlay["sources"];
  payload: SafetyScoreV9OperationalResilienceOverlay;
  payloadSha256: string;
} | null {
  const overlay = getSafetyScoreV9OperationalResilienceOverlay(assetId, clockSec);
  return overlay
    ? {
        reviewedAt: overlay.reviewedAt,
        expiresAt: overlay.expiresAt,
        sources: overlay.sources,
        payload: overlay,
        payloadSha256: SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST,
      }
    : null;
}
