import { z } from "zod";
import {
  V9CapSourceSchema,
  V9EvidenceLevelSchema,
  V9ReasonCodeSchema,
  type V9ReasonCode,
} from "./safety-score-v9";
import { compareText } from "./safety-score-v9-fact-primitives";
import { V9_ACCESS_POSTURE_FIELDS, V9_EVIDENCE_RESPONSIBILITIES } from "./safety-score-v9-vocabulary";
import { V9AccessFreezeExposureSchema, V9AccessGovernanceSchema, V9AccessPostureFieldSchema } from "./safety-score-v9-vocabulary";
import { V9AccessPrimaryExitSchema, V9AccessTransferSchema } from "./safety-score-v9-vocabulary";

import { V9_GRADE_THRESHOLDS } from "./safety-score-v9-grade";

// Canonical ordering is a determinism-digest input; it has one definition.
export { BaseInputGenerationIdSchema, Sha256Schema } from "./safety-schema-primitives";
export const ScoreSchema = z.number().finite().min(0).max(100);
export const V9PolicyVersionSchema = z.string().regex(/^\d+\.\d+$/);
export const RESPONSIBILITIES = V9_EVIDENCE_RESPONSIBILITIES;
export const SCORE_TOLERANCE = 0.0002;
export const EXIT_SCORE_TOLERANCE = 0.03;
export const PUBLIC_SCORE_ROUNDING_HEADROOM = 0.5;
// Validation-only mirrors of policy-owned values: these check published output rather than
// computing it, so they are deliberately NOT admitted to the policy digest — that would rotate it
// without changing any score. They should still be derived, because a validator that re-encodes a
// threshold can reject a correct publication once the policy moves.
export const C_MINUS_MIN_SCORE =
  V9_GRADE_THRESHOLDS.find((threshold) => threshold.grade === "C-")?.min ?? 50;
// Not derivable here without importing the methodology data asset into the public-schema layer.
// This remains a validation-only mirror; scoring reads the canonical danger floor from the parsed
// policy envelope, while shared/types stays independent of shared/lib policy loading.
export const DANGER_PEG_MULTIPLIER_FLOOR = 0.9;
export const V9_BOUNDED_ATTRIBUTION_REASON_CODES = [
  "bounded-mechanism-review",
  "bounded-unknown-reserve-exposure",
  "incomparable-route-requests",
  "incomplete-dex-route-coverage",
  "incomplete-oracle-liquidation-branch",
  "material-bridge-supply-unmatched",
  "material-dependency-unavailable",
  "material-reserve-slice-unstructured",
  "material-unknown-reserve-exposure",
  "mint-control-question",
  "missing-applicable-peg",
  "missing-bridge-route-rows",
  "missing-bridge-routes",
  "missing-custody-profile",
  "missing-implementation-date",
  "missing-latest-assurance-report",
  "missing-mint-authority",
  "missing-oracle-profile",
  "missing-peg-input",
  "missing-required-oracle-branches",
  "missing-reserve-composition",
  "missing-runtime-route-evidence",
  "missing-same-notional-route",
  "unproven-settlement-bound",
  "missing-upgrade-control",
  "missing-upgradeability-review",
  "partial-reserve-review",
  "stale-audited-reserve-composition",
  "peg-price-unavailable-adverse-history",
  "peg-supply-floor-withheld",
  "runtime-bridge-materiality-unavailable",
  "scoped-control-question",
  "selected-bridge-route-missing",
  "selected-bridge-route-unresolved",
  "unknown-control-cap-authority",
  "unknown-control-mint-ability",
  "unknown-upgrade-authority",
  "unresolved-control-identity",
  "unresolved-mint-authority",
  "unresolved-oracle-branch-applicability",
  "unsupported-same-notional-route",
  "unreviewed-dependency-relationships",
  "unreviewed-oracle-profile",
  "unreviewed-reserve-envelope",
] as const satisfies readonly V9ReasonCode[];
export const V9_BOUNDED_ATTRIBUTION_REASON_CODE_SET =
  new Set<V9ReasonCode>(V9_BOUNDED_ATTRIBUTION_REASON_CODES);


export function isUniqueSorted(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

export function numbersAgree(left: number | null, right: number | null): boolean {
  return left === null || right === null ? left === right : Math.abs(left - right) <= SCORE_TOLERANCE;
}

export function roundAttributionValue(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(Number((value * factor).toPrecision(15))) / factor;
}

const SafetyScoreV9PublicReasonSchema = z
  .object({
    code: V9ReasonCodeSchema,
    message: z.string().min(1),
    path: z.string().min(1).nullable(),
  })
  .strict();
export type SafetyScoreV9PublicReason = z.infer<typeof SafetyScoreV9PublicReasonSchema>;

export const SafetyScoreV9PublicReasonListSchema = z
  .array(SafetyScoreV9PublicReasonSchema)
  .superRefine((reasons, ctx) => {
    const identities = new Set<string>();
    reasons.forEach((reason, index) => {
      const identity = `${reason.code}\u0000${reason.path ?? ""}`;
      if (identities.has(identity)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "V9 public reasons must have unique code/path identities",
        });
      }
      identities.add(identity);
    });
  });

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
    reasons: SafetyScoreV9PublicReasonListSchema,
  })
  .strict()
  .superRefine((pillar, ctx) => {
    if (!isUniqueSorted(pillar.components)) {
      ctx.addIssue({ code: "custom", path: ["components"], message: "V9 pillar components must be unique and sorted" });
    }
  });

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
    transfer: V9AccessTransferSchema,
    freezeExposure: V9AccessFreezeExposureSchema,
    primaryExit: V9AccessPrimaryExitSchema,
    governance: V9AccessGovernanceSchema,
    unknownFields: z.array(V9AccessPostureFieldSchema),
    signals: z.array(z.string().min(1)),
    reasons: SafetyScoreV9PublicReasonListSchema,
  })
  .strict()
  .superRefine((posture, ctx) => {
    const expectedUnknown = V9_ACCESS_POSTURE_FIELDS
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
