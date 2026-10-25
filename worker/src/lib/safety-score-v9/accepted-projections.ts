import { z } from "zod";
import { SafetyScoreCohortSchema, SAFETY_SCORE_COHORT_MAX_BYTES, type SafetyScoreCohort, type SafetyScoreCohortStoredCard } from "@shared/types/safety-score-cohort";
import { resolveV9PublicWitnessTexts } from "@shared/types/safety-score-v9-public-witness-texts";
import { buildReportCardsV9DependencyGraph } from "@shared/types/report-cards-v9";
import { compareCodeUnits } from "@shared/lib/compare";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { SafetyScoreV9PublicationIdentitySchema } from "@shared/types/safety-score-publication";
import { Sha256Schema, UnixSecondsSchema } from "@shared/types/safety-schema-primitives";
import { LenderCollateralBackingSchema, type LenderCollateralBacking } from "@shared/types/safety-score-v9-lender-book";
import { resolveCauseGapId } from "@shared/types/safety-score-v9-public-cause-gaps";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { buildSafetyScoreV9PublicationIdentity } from "../report-cards-v9-cache";
import { logWorkerEvent } from "../structured-log";
import { AcceptedPublicationBaselineSchema, buildSafetyScoreV9AcceptedPublicationBaseline } from "./publication-assessment";

// Prerequisite-E sizing (2026-10-15): real accepted baseline 111,663 B and
// all-eligible lender inventory 250,179 B. Caps are >=4x the larger observed
// size, rounded up to 64 KiB; writes above half a cap log a warning first.
export const SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES = 458_752;
export const SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES = 1_048_576;

export type AcceptedProjectionUnavailableReason =
  | "projection-missing" | "projection-invalid" | "publication-invalid" | "publication-mismatch"
  | "health-unavailable" | "health-mismatch" | "read-failed";
const AcceptedProjectionHeaderSchema = z.strictObject({
  schemaVersion: z.literal(1),
  safetyScoreIdentity: SafetyScoreV9PublicationIdentitySchema,
  publicationResultDigest: Sha256Schema,
  asOfSec: UnixSecondsSchema,
  publishedAtSec: UnixSecondsSchema,
  expectedCount: z.number().int().nonnegative(),
}).refine((value) => value.asOfSec <= value.publishedAtSec, {
  path: ["asOfSec"], message: "Projection source clock must not postdate publication",
});
export type AcceptedProjectionHeaderV1 = z.infer<typeof AcceptedProjectionHeaderSchema>;

const SafetyScoreV9AcceptedBaselineProjectionSchema = AcceptedProjectionHeaderSchema.safeExtend({
  baseline: AcceptedPublicationBaselineSchema,
}).superRefine((value, ctx) => {
  const identity = value.safetyScoreIdentity;
  const baseline = value.baseline;
  if (baseline.publicationGenerationId !== identity.publicationGenerationId ||
      baseline.policyVersion !== identity.methodologyVersion || baseline.policyId !== identity.policyId ||
      baseline.policyDigest !== identity.policyDigest || baseline.evaluationBuildDigest !== identity.evaluationBuildDigest ||
      baseline.publishedAtSec !== value.publishedAtSec) {
    ctx.addIssue({ code: "custom", path: ["baseline"], message: "Baseline identity and clock must match projection header" });
  }
  if (baseline.cards.length !== value.expectedCount) {
    ctx.addIssue({ code: "custom", path: ["baseline", "cards"], message: "Baseline must retain every accepted card" });
  }
});
export type SafetyScoreV9AcceptedBaselineProjectionV1 = z.infer<typeof SafetyScoreV9AcceptedBaselineProjectionSchema>;

const SafetyScoreV9LenderCollateralProjectionSchema = AcceptedProjectionHeaderSchema.safeExtend({
  byAssetId: LenderCollateralBackingSchema.shape.byAssetId,
}).superRefine((value, ctx) => {
  const rows = Object.entries(value.byAssetId);
  if (rows.length > value.expectedCount) {
    ctx.addIssue({ code: "custom", path: ["byAssetId"], message: "Eligible inventory exceeds accepted card count" });
  }
  for (const [key, row] of rows) {
    if (key !== row.assetId) ctx.addIssue({ code: "custom", path: ["byAssetId", key], message: "Eligible row key must match asset ID" });
  }
});
export type SafetyScoreV9LenderCollateralProjectionV1 = z.infer<typeof SafetyScoreV9LenderCollateralProjectionSchema>;

function projectionHeader(publication: Readonly<SafetyScoreV9CurrentResponse>): AcceptedProjectionHeaderV1 {
  return {
    schemaVersion: 1, safetyScoreIdentity: buildSafetyScoreV9PublicationIdentity(publication),
    publicationResultDigest: publication.resultDigest, asOfSec: publication.asOfSec,
    publishedAtSec: publication.publishedAtSec, expectedCount: publication.completeness.expectedCount,
  };
}

export function buildSafetyScoreV9AcceptedBaselineProjection(
  publication: Readonly<SafetyScoreV9CurrentResponse>,
): SafetyScoreV9AcceptedBaselineProjectionV1 {
  return SafetyScoreV9AcceptedBaselineProjectionSchema.parse({
    ...projectionHeader(publication), baseline: buildSafetyScoreV9AcceptedPublicationBaseline(publication),
  });
}

export function buildSafetyScoreV9LenderCollateralProjection(
  publication: Readonly<SafetyScoreV9CurrentResponse>,
): SafetyScoreV9LenderCollateralProjectionV1 {
  const byAssetId: LenderCollateralBacking["byAssetId"] = {};
  // Retain the full eligible inventory; capture owns only registry-bound subsetting.
  for (const card of publication.cards) {
    const backing = card.pillars.backing;
    if (card.ratingStatus !== "rated" || backing.aggregationDisposition === "excluded-a-b" ||
        backing.score === null || !Number.isFinite(backing.score) || backing.score < 0 || backing.score > 100) continue;
    const sourceCause = (["D", "C", "U"] as const).find((cause) => backing.limitedEvidenceCauses?.includes(cause)) ?? null;
    const sourceGapIds = [...new Set((backing.causeGapRefs ?? []).map((ref) => resolveCauseGapId(publication, card, ref)))].sort(compareCodeUnits);
    if ((sourceCause === "C" || sourceCause === "U") && sourceGapIds.length === 0) continue;
    byAssetId[card.id] = {
      assetId: card.id, backingScore: backing.score,
      cardSha256: sha256Hex(stableJsonStringifyV1(card)), sourceCause, sourceGapIds,
    };
  }
  return SafetyScoreV9LenderCollateralProjectionSchema.parse({
    ...projectionHeader(publication),
    byAssetId: Object.fromEntries(Object.entries(byAssetId).sort(([a], [b]) => compareCodeUnits(a, b))),
  });
}

export function buildSafetyScoreV9CohortProjection(publication: Readonly<SafetyScoreV9CurrentResponse>): SafetyScoreCohort {
  const edges: SafetyScoreCohort["dependencyGraph"]["edges"] = [];
  const cards = publication.cards.map((canonical): SafetyScoreCohortStoredCard => {
    // Resolve one card at a time: graph provenance, cap reasons and mint posture may be interned.
    const card = resolveV9PublicWitnessTexts(canonical);
    edges.push(...buildReportCardsV9DependencyGraph([card]).edges);
    const projectPillar = (pillar: typeof card.pillars.backing) => ({
      score: pillar.score, aggregationDisposition: pillar.aggregationDisposition,
      evidenceLevel: pillar.evidenceLevel, freshness: pillar.freshness,
      reasons: pillar.reasons.map(({ code, message }) => ({ code, message })),
    });
    const projectCap = ({ kind, limit, reason, binding }: typeof card.caps[number]) => ({ kind, limit, reason, binding });
    const mint = card.breakdowns?.control.components.find((component) => component.kind === "mint");
    return {
      id: card.id,
      ...(card.sharedBookId === undefined ? {} : { sharedBookId: card.sharedBookId }),
      ...(card.supply === undefined ? {} : { supply: {
        circulatingUsdAtEvaluation: card.supply.circulatingUsdAtEvaluation, asOfSec: card.supply.asOfSec,
      } }),
      ...(card.dependencyCoverage === undefined ? {} : { dependencyCoverage: { length: card.dependencyCoverage.length } }),
      pillars: { backing: projectPillar(card.pillars.backing), exit: projectPillar(card.pillars.exit), control: projectPillar(card.pillars.control) },
      caps: card.caps.map(projectCap),
      reasonCodes: card.reasonCodes,
      scoreTrace: {
        aggregation: card.scoreTrace.aggregation === null ? null : { pricedUnknownPillars: card.scoreTrace.aggregation.pricedUnknownPillars },
        deploymentRisk: { adjustments: card.scoreTrace.deploymentRisk.adjustments.map(({ scoreBefore, scoreAfter, adjustmentPoints }) => ({ scoreBefore, scoreAfter, adjustmentPoints })) },
      },
      dependencies: {
        ...(card.dependencies.roles === undefined ? {} : { roles: card.dependencies.roles.map(({ upstreamAssetId, role, weight }) => ({ upstreamAssetId, role, weight })) }),
      },
      breakdowns: card.breakdowns === null ? null : {
        control: { components: mint === undefined ? [] : [{ kind: mint.kind, posture: mint.posture }] },
        exit: { stressRequest: card.breakdowns.exit.stressRequest,
          primaryRoute: card.breakdowns.exit.primaryRoute === null ? null : {
            key: card.breakdowns.exit.primaryRoute.key, score: card.breakdowns.exit.primaryRoute.score, capacity: card.breakdowns.exit.primaryRoute.capacity,
          },
        },
      },
    };
  });
  edges.sort((a, b) => compareCodeUnits(`${a.from}\u0000${a.to}\u0000${a.kind}`, `${b.from}\u0000${b.to}\u0000${b.kind}`));
  return SafetyScoreCohortSchema.parse({
    schemaVersion: 1, safetyScoreIdentity: buildSafetyScoreV9PublicationIdentity(publication),
    publicationResultDigest: publication.resultDigest, asOfSec: publication.asOfSec,
    publishedAtSec: publication.publishedAtSec,
    dependencyGraph: { edges }, cards,
    ...(publication.commonModeGroups === undefined ? {} : { commonModeGroups: publication.commonModeGroups }),
  });
}

export function serializeSafetyScoreV9CohortProjection(value: SafetyScoreCohort): string {
  return serializeProjection(SafetyScoreCohortSchema, value, SAFETY_SCORE_COHORT_MAX_BYTES);
}

function serializeProjection<T>(schema: z.ZodType<T>, value: T, maximumBytes: number): string {
  const stored = stableJsonStringifyV1(schema.parse(value));
  if (new TextEncoder().encode(stored).byteLength > maximumBytes) {
    throw new Error(`Accepted projection exceeds ${maximumBytes} bytes`);
  }
  return stored;
}

function parseProjection<T extends AcceptedProjectionHeaderV1>(
  schema: z.ZodType<T>, row: { value: string; updatedAt: number }, maximumBytes: number,
): T {
  if (new TextEncoder().encode(row.value).byteLength > maximumBytes) {
    throw new Error(`Accepted projection exceeds ${maximumBytes} bytes`);
  }
  const projection = schema.parse(JSON.parse(row.value));
  if (stableJsonStringifyV1(projection) !== row.value) throw new Error("Accepted projection JSON is not canonical");
  if (row.updatedAt !== projection.publishedAtSec) throw new Error("Accepted projection row clock does not match publication");
  return projection;
}

export function serializeSafetyScoreV9AcceptedBaselineProjection(value: SafetyScoreV9AcceptedBaselineProjectionV1): string {
  return serializeProjection(SafetyScoreV9AcceptedBaselineProjectionSchema, value, SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES);
}
export function parseSafetyScoreV9AcceptedBaselineProjection(row: { value: string; updatedAt: number }): SafetyScoreV9AcceptedBaselineProjectionV1 {
  return parseProjection(SafetyScoreV9AcceptedBaselineProjectionSchema, row, SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES);
}
export function serializeSafetyScoreV9LenderCollateralProjection(value: SafetyScoreV9LenderCollateralProjectionV1): string {
  return serializeProjection(SafetyScoreV9LenderCollateralProjectionSchema, value, SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES);
}
export function parseSafetyScoreV9LenderCollateralProjection(row: { value: string; updatedAt: number }): SafetyScoreV9LenderCollateralProjectionV1 {
  return parseProjection(SafetyScoreV9LenderCollateralProjectionSchema, row, SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES);
}

export function buildSafetyScoreV9AcceptedProjections(publication: Readonly<SafetyScoreV9CurrentResponse>): { baseline: string; lender: string; cohort: string } {
  const projections = {
    cohort: serializeSafetyScoreV9CohortProjection(buildSafetyScoreV9CohortProjection(publication)),
    baseline: serializeSafetyScoreV9AcceptedBaselineProjection(buildSafetyScoreV9AcceptedBaselineProjection(publication)),
    lender: serializeSafetyScoreV9LenderCollateralProjection(buildSafetyScoreV9LenderCollateralProjection(publication)),
  };
  const cohortBytes = new TextEncoder().encode(projections.cohort).byteLength;
  const baselineBytes = new TextEncoder().encode(projections.baseline).byteLength;
  const lenderBytes = new TextEncoder().encode(projections.lender).byteLength;
  if (cohortBytes * 2 > SAFETY_SCORE_COHORT_MAX_BYTES ||
      baselineBytes * 2 > SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES ||
      lenderBytes * 2 > SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES) {
    logWorkerEvent({
      scope: "lib", level: "warn", event: "safety_score_v9_accepted_projection_size_warning",
      message: "Accepted Safety Score v9 projection exceeds half its byte cap",
      metadata: {
        cohortBytes, cohortMaxBytes: SAFETY_SCORE_COHORT_MAX_BYTES,
        baselineBytes, baselineMaxBytes: SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES,
        lenderBytes, lenderMaxBytes: SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES,
      },
    });
  }
  return projections;
}
