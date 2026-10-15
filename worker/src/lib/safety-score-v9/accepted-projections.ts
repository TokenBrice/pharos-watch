import { z } from "zod";
import { compareCodeUnits } from "@shared/lib/compare";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { SafetyScoreV9PublicationIdentitySchema } from "@shared/types/safety-score-publication";
import { NonNegativeFiniteSchema, ScoreSchema, Sha256Schema, UnixSecondsSchema } from "@shared/types/safety-schema-primitives";
import { V9GradeSchema } from "@shared/types/safety-score-v9";
import { LenderCollateralBackingSchema, type LenderCollateralBacking } from "@shared/types/safety-score-v9-lender-book";
import { resolveCauseGapId } from "@shared/types/safety-score-v9-public-cause-gaps";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { buildSafetyScoreV9PublicationIdentity } from "../report-cards-v9-cache";
import { logWorkerEvent } from "../structured-log";
import { buildSafetyScoreV9AcceptedPublicationBaseline } from "./publication-assessment";
import type { SafetyScoreV9AcceptedCardBaseline, SafetyScoreV9AcceptedPublicationBaseline } from "./publication-assessment";

// Prerequisite-E sizing (2026-10-15): real accepted baseline 111,663 B and
// all-eligible lender inventory 250,179 B. Caps are >=4x the larger observed
// size, rounded up to 64 KiB; writes above half a cap log a warning first.
export const SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES = 458_752;
export const SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES = 1_048_576;

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

const AcceptedCardBaselineSchema = z.strictObject({
  id: z.string().min(1), grade: V9GradeSchema.nullable(), score: ScoreSchema.nullable(),
  primaryRouteKey: z.string().min(1).nullable(), diversificationRouteKey: z.string().min(1).nullable(),
  primaryRouteCapacityUsd: NonNegativeFiniteSchema.nullable(),
  pillarScores: z.strictObject({
    backing: ScoreSchema.nullable(), exit: ScoreSchema.nullable(), control: ScoreSchema.nullable(),
  }).nullable(),
}) satisfies z.ZodType<SafetyScoreV9AcceptedCardBaseline>;

const AcceptedPublicationBaselineSchema = z.strictObject({
  publicationGenerationId: z.string().min(1), publishedAtSec: UnixSecondsSchema,
  policyVersion: z.string().min(1), policyId: z.string().min(1), policyDigest: Sha256Schema,
  evaluationBuildDigest: Sha256Schema, dexGenerationId: z.string().min(1).nullable(),
  cards: z.array(AcceptedCardBaselineSchema),
}).superRefine((value, ctx) => {
  if (value.cards.some((card, index) => index > 0 && compareCodeUnits(value.cards[index - 1]!.id, card.id) >= 0)) {
    ctx.addIssue({ code: "custom", path: ["cards"], message: "Baseline card IDs must be unique and sorted" });
  }
}) satisfies z.ZodType<SafetyScoreV9AcceptedPublicationBaseline>;

export type SafetyScoreV9AcceptedBaselineProjectionV1 = AcceptedProjectionHeaderV1 & {
  baseline: SafetyScoreV9AcceptedPublicationBaseline;
};
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
}) satisfies z.ZodType<SafetyScoreV9AcceptedBaselineProjectionV1>;

export type SafetyScoreV9LenderCollateralProjectionV1 = AcceptedProjectionHeaderV1 & {
  byAssetId: LenderCollateralBacking["byAssetId"];
};
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
}) satisfies z.ZodType<SafetyScoreV9LenderCollateralProjectionV1>;

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

export function buildSafetyScoreV9AcceptedProjections(publication: Readonly<SafetyScoreV9CurrentResponse>): { baseline: string; lender: string } {
  const projections = {
    baseline: serializeSafetyScoreV9AcceptedBaselineProjection(buildSafetyScoreV9AcceptedBaselineProjection(publication)),
    lender: serializeSafetyScoreV9LenderCollateralProjection(buildSafetyScoreV9LenderCollateralProjection(publication)),
  };
  const baselineBytes = new TextEncoder().encode(projections.baseline).byteLength;
  const lenderBytes = new TextEncoder().encode(projections.lender).byteLength;
  if (baselineBytes * 2 > SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES ||
      lenderBytes * 2 > SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES) {
    logWorkerEvent({
      scope: "lib", level: "warn", event: "safety_score_v9_accepted_projection_size_warning",
      message: "Accepted Safety Score v9 projection exceeds half its byte cap",
      metadata: {
        baselineBytes, baselineMaxBytes: SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES,
        lenderBytes, lenderMaxBytes: SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES,
      },
    });
  }
  return projections;
}
