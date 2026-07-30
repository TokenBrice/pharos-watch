import { z } from "zod";
import {
  V9CapSourceSchema,
  V9EvidenceLevelSchema,
  V9ReasonCodeSchema,
  type V9ReasonCode,
} from "./safety-score-v9";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);
export const ScoreSchema = z.number().finite().min(0).max(100);
export const CandidatePolicyVersionSchema = z.string().regex(/^candidate-[a-z0-9][a-z0-9._-]*$/);
export const V9PolicyVersionSchema = z.string().regex(/^\d+\.\d+$/);
const AccessPostureFieldSchema = z.enum(["transfer", "freezeExposure", "primaryExit", "governance"]);
export const RESPONSIBILITIES = [
  "integration-missing",
  "issuer-undisclosed",
  "measured-adverse",
  "method-unsupported",
  "producer-failed",
] as const;
export const SCORE_TOLERANCE = 0.0002;
export const EXIT_SCORE_TOLERANCE = 0.03;
export const PUBLIC_SCORE_ROUNDING_HEADROOM = 0.5;
export const C_MINUS_MIN_SCORE = 50;
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
  "missing-upgrade-control",
  "missing-upgradeability-review",
  "partial-reserve-review",
  "peg-price-unavailable-adverse-history",
  "peg-supply-floor-withheld",
  "runtime-bridge-materiality-unavailable",
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

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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

export const SafetyScoreV9PublicReasonSchema = z
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
    reasons: SafetyScoreV9PublicReasonListSchema,
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
