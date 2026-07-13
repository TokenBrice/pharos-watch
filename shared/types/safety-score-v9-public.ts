import { z } from "zod";
import {
  V9CapSourceSchema,
  V9EvidenceLevelSchema,
  V9GradeSchema,
  V9QualityPillarSchema,
  V9ReasonCodeSchema,
} from "./safety-score-v9";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);
const ScoreSchema = z.number().finite().min(0).max(100);
const CandidatePolicyVersionSchema = z.string().regex(/^candidate-[a-z0-9][a-z0-9._-]*$/);
const AccessPostureFieldSchema = z.enum(["transfer", "freezeExposure", "primaryExit", "governance"]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isUniqueSorted(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

export const SafetyScoreV9PublicReasonSchema = z
  .object({
    code: V9ReasonCodeSchema,
    message: z.string().min(1),
    path: z.string().min(1).nullable(),
  })
  .strict();
export type SafetyScoreV9PublicReason = z.infer<typeof SafetyScoreV9PublicReasonSchema>;

export const SafetyScoreV9NrReasonSchema = z
  .object({
    code: V9ReasonCodeSchema,
    message: z.string().min(1),
    field: z.string().min(1).nullable(),
    origin: z.enum(["asset", "upstream"]),
  })
  .strict();
export type SafetyScoreV9NrReason = z.infer<typeof SafetyScoreV9NrReasonSchema>;

export const SafetyScoreV9EvidenceFreshnessSchema = z.enum(["current", "stale", "unknown"]);
export type SafetyScoreV9EvidenceFreshness = z.infer<typeof SafetyScoreV9EvidenceFreshnessSchema>;

export const SafetyScoreV9PillarSchema = z
  .object({
    score: ScoreSchema.nullable(),
    evidenceLevel: V9EvidenceLevelSchema,
    freshness: SafetyScoreV9EvidenceFreshnessSchema,
    components: z.array(z.string().min(1)),
    reasons: z.array(SafetyScoreV9PublicReasonSchema),
  })
  .strict()
  .superRefine((pillar, ctx) => {
    if (!isUniqueSorted(pillar.components)) {
      ctx.addIssue({ code: "custom", path: ["components"], message: "V9 pillar components must be unique and sorted" });
    }
  });
export type SafetyScoreV9Pillar = z.infer<typeof SafetyScoreV9PillarSchema>;

export const SafetyScoreV9CapSchema = z
  .object({
    kind: z.string().min(1),
    limit: ScoreSchema,
    source: V9CapSourceSchema,
    reason: z.string().min(1),
    binding: z.boolean(),
  })
  .strict();
export type SafetyScoreV9Cap = z.infer<typeof SafetyScoreV9CapSchema>;

export const SafetyScoreV9AccessPostureSchema = z
  .object({
    transfer: z.enum(["permissionless", "restrictable", "permissioned", "unknown"]),
    freezeExposure: z.enum(["none-known", "upstream", "direct", "possible", "unknown"]),
    primaryExit: z.enum(["permissionless", "eligibility-gated", "issuer-discretionary", "none", "unknown"]),
    governance: z.enum(["immutable", "distributed", "concentrated", "single-entity", "unknown"]),
    unknownFields: z.array(AccessPostureFieldSchema),
    signals: z.array(z.string().min(1)),
    reasons: z.array(SafetyScoreV9PublicReasonSchema),
  })
  .strict()
  .superRefine((posture, ctx) => {
    const expectedUnknown = (["transfer", "freezeExposure", "primaryExit", "governance"] as const)
      .filter((field) => posture[field] === "unknown")
      .sort(compareText);
    if (JSON.stringify(posture.unknownFields) !== JSON.stringify(expectedUnknown)) {
      ctx.addIssue({
        code: "custom",
        path: ["unknownFields"],
        message: "V9 access unknown fields must exactly match unknown posture values",
      });
    }
    if (!isUniqueSorted(posture.signals)) {
      ctx.addIssue({ code: "custom", path: ["signals"], message: "V9 access signals must be unique and sorted" });
    }
  });
export type SafetyScoreV9AccessPosture = z.infer<typeof SafetyScoreV9AccessPostureSchema>;

const SafetyScoreV9SerialDependencySchema = z
  .object({
    upstreamAssetId: z.string().min(1),
    score: ScoreSchema.nullable(),
    blocked: z.boolean(),
  })
  .strict();

const SafetyScoreV9BasketDependencySchema = z
  .object({
    upstreamAssetId: z.string().min(1),
    weight: z.number().finite().min(0).max(1),
    score: ScoreSchema.nullable(),
    boundedUnknown: z.boolean(),
  })
  .strict();

export const SafetyScoreV9DependencySummarySchema = z
  .object({
    serial: z.array(SafetyScoreV9SerialDependencySchema),
    basket: z.array(SafetyScoreV9BasketDependencySchema),
    cycleBlocked: z.boolean(),
    reasonCodes: z.array(V9ReasonCodeSchema),
  })
  .strict()
  .superRefine((summary, ctx) => {
    for (const field of ["serial", "basket"] as const) {
      const ids = summary[field].map((dependency) => dependency.upstreamAssetId);
      if (!isUniqueSorted(ids)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `V9 ${field} dependencies must have unique, sorted upstream IDs`,
        });
      }
    }
    if (!isUniqueSorted(summary.reasonCodes)) {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "V9 dependency reasons must be unique and sorted",
      });
    }
  });
export type SafetyScoreV9DependencySummary = z.infer<typeof SafetyScoreV9DependencySummarySchema>;

export const SafetyScoreV9EvidenceSummarySchema = z
  .object({
    level: V9EvidenceLevelSchema,
    freshness: SafetyScoreV9EvidenceFreshnessSchema,
    reasons: z.array(SafetyScoreV9PublicReasonSchema),
  })
  .strict();
export type SafetyScoreV9EvidenceSummary = z.infer<typeof SafetyScoreV9EvidenceSummarySchema>;

export const SafetyScoreV9CardSchema = z
  .object({
    id: z.string().min(1),
    score: ScoreSchema.nullable(),
    grade: V9GradeSchema,
    qualityScore: ScoreSchema.nullable(),
    pegMultiplier: z.number().finite().min(0).max(1).nullable(),
    pegAdjustedScore: ScoreSchema.nullable(),
    pillars: z
      .object({
        backing: SafetyScoreV9PillarSchema,
        exit: SafetyScoreV9PillarSchema,
        control: SafetyScoreV9PillarSchema,
      })
      .strict(),
    weakestPillar: z.object({ pillar: V9QualityPillarSchema, score: ScoreSchema }).strict().nullable(),
    caps: z.array(SafetyScoreV9CapSchema),
    bindingCap: SafetyScoreV9CapSchema.nullable(),
    nrReasons: z.array(SafetyScoreV9NrReasonSchema),
    reasonCodes: z.array(V9ReasonCodeSchema),
    evidence: SafetyScoreV9EvidenceSummarySchema,
    accessPosture: SafetyScoreV9AccessPostureSchema,
    dependencies: SafetyScoreV9DependencySummarySchema,
    stressStateDigest: Sha256Schema.nullable(),
  })
  .strict()
  .superRefine((card, ctx) => {
    if ((card.score === null) !== (card.grade === "NR")) {
      ctx.addIssue({ code: "custom", path: ["grade"], message: "NR grade and null score must agree" });
    }
    if (card.score !== null && Object.values(card.pillars).some((pillar) => pillar.score === null)) {
      ctx.addIssue({ code: "custom", path: ["pillars"], message: "A rated result requires all three pillars" });
    }
    if (
      card.score !== null &&
      (card.qualityScore === null || card.pegAdjustedScore === null || card.pegMultiplier === null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["qualityScore"],
        message: "A rated result requires quality and peg-adjusted scores",
      });
    }
    if (card.score === null && card.nrReasons.length === 0) {
      ctx.addIssue({ code: "custom", path: ["nrReasons"], message: "An NR result requires an explicit reason" });
    }
    if (card.score !== null && card.nrReasons.length > 0) {
      ctx.addIssue({ code: "custom", path: ["nrReasons"], message: "A rated result cannot carry NR reasons" });
    }
    const bindingCaps = card.caps.filter((cap) => cap.binding);
    if (bindingCaps.length > 1) {
      ctx.addIssue({ code: "custom", path: ["caps"], message: "At most one V9 cap candidate may bind" });
    }
    if (
      card.bindingCap === null
        ? bindingCaps.length !== 0
        : JSON.stringify(bindingCaps) !== JSON.stringify([card.bindingCap])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["bindingCap"],
        message: "V9 binding cap must match the binding cap candidate",
      });
    }
    if (!isUniqueSorted(card.reasonCodes)) {
      ctx.addIssue({ code: "custom", path: ["reasonCodes"], message: "V9 reason codes must be unique and sorted" });
    }
  });
export type SafetyScoreV9Card = z.infer<typeof SafetyScoreV9CardSchema>;

export const SafetyScoreV9CompletenessSchema = z
  .object({
    expectedCount: z.number().int().nonnegative(),
    ratedCount: z.number().int().nonnegative(),
    notRatedCount: z.number().int().nonnegative(),
    notRatedIds: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expectedCount !== value.ratedCount + value.notRatedCount) {
      ctx.addIssue({ code: "custom", message: "V9 completeness counts do not reconcile" });
    }
    if (value.notRatedIds.length !== value.notRatedCount || !isUniqueSorted(value.notRatedIds)) {
      ctx.addIssue({ code: "custom", path: ["notRatedIds"], message: "V9 not-rated IDs do not reconcile" });
    }
  });

/** Pre-release envelope. Active V9 is deliberately not part of this contract. */
export const SafetyScoreV9ResponseSchema = z
  .object({
    model: z.literal("v9-critical-path"),
    schemaVersion: z.literal(1),
    lifecycle: z.literal("candidate"),
    candidateId: z.string().min(1),
    policyVersion: CandidatePolicyVersionSchema,
    publicationGenerationId: z.string().min(1),
    baseInputGenerationId: BaseInputGenerationIdSchema,
    factSetDigest: Sha256Schema,
    resultDigest: Sha256Schema,
    policy: z.object({ id: z.string().min(1), semanticDigest: Sha256Schema }).strict(),
    evaluationBuildDigest: Sha256Schema,
    sourceGenerations: z.record(z.string().min(1), z.string().min(1)),
    asOfSec: z.number().int().nonnegative(),
    publishedAtSec: z.number().int().nonnegative(),
    completeness: SafetyScoreV9CompletenessSchema,
    cards: z.array(SafetyScoreV9CardSchema),
  })
  .strict()
  .superRefine((response, ctx) => {
    if (response.publishedAtSec < response.asOfSec) {
      ctx.addIssue({ code: "custom", path: ["publishedAtSec"], message: "Publication cannot predate evidence" });
    }
    if (response.cards.length !== response.completeness.expectedCount) {
      ctx.addIssue({ code: "custom", path: ["cards"], message: "V9 card set is not complete" });
    }
    const ids = response.cards.map((card) => card.id);
    if (!isUniqueSorted(ids)) {
      ctx.addIssue({ code: "custom", path: ["cards"], message: "V9 card IDs must be unique and sorted" });
    }
    const notRatedIds = response.cards.filter((card) => card.grade === "NR").map((card) => card.id);
    if (JSON.stringify(notRatedIds) !== JSON.stringify(response.completeness.notRatedIds)) {
      ctx.addIssue({ code: "custom", path: ["completeness"], message: "V9 NR membership does not reconcile" });
    }
  });
export type SafetyScoreV9Response = z.infer<typeof SafetyScoreV9ResponseSchema>;
