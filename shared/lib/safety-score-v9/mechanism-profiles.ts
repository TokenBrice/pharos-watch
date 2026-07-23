import { z } from "zod";
import type {
  V9EvidenceResponsibility,
  V9ObservationState,
} from "../../types/safety-score-v9-fact-primitives";
import type { V9MechanismQualityLevel } from "../../types/safety-score-v9-backing";

const V9MechanismQualityLevelSchema = z.enum(["strong", "adequate", "limited", "weak", "failed"]);

const V9SupportedProfileFactSchema = z
  .object({
    disposition: z.literal("supported"),
    quality: V9MechanismQualityLevelSchema,
  })
  .strict();

const V9UnavailableProfileFactSchema = z
  .object({
    disposition: z.enum(["issuer-undisclosed", "integration-missing", "method-unsupported"]),
  })
  .strict();

export const V9MechanismProfileFactSchema = z.union([
  V9SupportedProfileFactSchema,
  V9UnavailableProfileFactSchema,
]);
export type V9MechanismProfileFact = z.infer<typeof V9MechanismProfileFactSchema>;

const AllocatedCommodityFactsSchema = z
  .object({
    holderTitle: V9MechanismProfileFactSchema,
    physicalAllocation: V9MechanismProfileFactSchema,
    custodianSegregation: V9MechanismProfileFactSchema,
    bankruptcyRemoteness: V9MechanismProfileFactSchema,
    custodyContinuity: V9MechanismProfileFactSchema,
    auditCadence: V9MechanismProfileFactSchema,
    reserveReconciliation: V9MechanismProfileFactSchema,
    insurance: V9MechanismProfileFactSchema,
    physicalRedemption: V9MechanismProfileFactSchema,
  })
  .strict();

const InflationIndexFactsSchema = z
  .object({
    collateralCoverage: V9MechanismProfileFactSchema,
    contractionLiquidity: V9MechanismProfileFactSchema,
    indexOracle: V9MechanismProfileFactSchema,
    reflexiveBackstop: V9MechanismProfileFactSchema,
    emergencyRecovery: V9MechanismProfileFactSchema,
    lossRecovery: V9MechanismProfileFactSchema,
    protocolRedemption: V9MechanismProfileFactSchema,
  })
  .strict();

const V9AllocatedCommodityProfileReviewSchema = z
  .object({
    profile: z.literal("allocated-commodity-claim"),
    facts: AllocatedCommodityFactsSchema,
  })
  .strict();

const V9InflationIndexProfileReviewSchema = z
  .object({
    profile: z.literal("inflation-index-hybrid"),
    exogenousBackingShare: z.number().finite().min(0).max(1),
    reflexiveBackingShare: z.number().finite().min(0).max(1),
    contractionCapacityRatio: z.number().finite().nonnegative(),
    facts: InflationIndexFactsSchema,
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.exogenousBackingShare + review.reflexiveBackingShare > 1.000001) {
      ctx.addIssue({
        code: "custom",
        path: ["reflexiveBackingShare"],
        message: "Inflation-index backing shares cannot exceed 1",
      });
    }
  });

export const V9MechanismProfileReviewSchema = z.discriminatedUnion("profile", [
  V9AllocatedCommodityProfileReviewSchema,
  V9InflationIndexProfileReviewSchema,
]);
export type V9MechanismProfileReview = z.infer<typeof V9MechanismProfileReviewSchema>;
export type V9MechanismScoringProfile = V9MechanismProfileReview["profile"];

export interface V9MechanismProfileComponentProjection {
  readonly observationState: V9ObservationState;
  readonly quality: V9MechanismQualityLevel | null;
  readonly factKeys: readonly string[];
}

export interface V9MechanismProfileProjection {
  readonly archetype: "fiat-cash" | "algorithmic";
  readonly components: Readonly<Record<string, V9MechanismProfileComponentProjection>>;
  readonly metrics: Readonly<Record<string, number>>;
  readonly exitFacts: Readonly<Record<string, V9MechanismProfileFact>>;
}

export interface V9MechanismProfileGap {
  readonly factKey: string;
  readonly responsibility: Extract<
    V9EvidenceResponsibility,
    "issuer-undisclosed" | "integration-missing" | "method-unsupported"
  >;
}

export interface V9MechanismProfileCoverage {
  readonly profile: V9MechanismScoringProfile;
  readonly complete: boolean;
  readonly supportedFactKeys: readonly string[];
  readonly gaps: readonly V9MechanismProfileGap[];
}

const QUALITY_ORDER: readonly V9MechanismQualityLevel[] = [
  "strong",
  "adequate",
  "limited",
  "weak",
  "failed",
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unavailableObservationState(
  disposition: Exclude<V9MechanismProfileFact["disposition"], "supported">,
): V9ObservationState {
  if (disposition === "issuer-undisclosed") return "bounded-unknown";
  if (disposition === "method-unsupported") return "unsupported";
  return "missing";
}

function combineProfileFacts(
  facts: Readonly<Record<string, V9MechanismProfileFact>>,
  factKeys: readonly string[],
): V9MechanismProfileComponentProjection {
  const selected = factKeys.map((key) => {
    const fact = facts[key];
    if (fact === undefined) throw new Error(`Safety Score v9 mechanism profile is missing required fact ${key}`);
    return fact;
  });
  const unavailable = selected.filter(
    (fact): fact is Extract<V9MechanismProfileFact, { disposition: Exclude<V9MechanismProfileFact["disposition"], "supported"> }> =>
      fact.disposition !== "supported",
  );
  if (unavailable.length > 0) {
    const dispositions = new Set(unavailable.map((fact) => fact.disposition));
    const disposition = dispositions.has("method-unsupported")
      ? "method-unsupported"
      : dispositions.has("integration-missing")
        ? "integration-missing"
        : "issuer-undisclosed";
    return {
      observationState: unavailableObservationState(disposition),
      quality: null,
      factKeys: [...factKeys],
    };
  }
  const supported = selected as Array<Extract<V9MechanismProfileFact, { disposition: "supported" }>>;
  const quality = supported.reduce(
    (weakest, fact) =>
      QUALITY_ORDER.indexOf(fact.quality) > QUALITY_ORDER.indexOf(weakest) ? fact.quality : weakest,
    "strong" as V9MechanismQualityLevel,
  );
  return { observationState: "known", quality, factKeys: [...factKeys] };
}

export function evaluateV9MechanismProfileCoverage(
  input: V9MechanismProfileReview,
): V9MechanismProfileCoverage {
  const review = V9MechanismProfileReviewSchema.parse(input);
  const entries = Object.entries(review.facts).sort(([left], [right]) => compareText(left, right));
  const supportedFactKeys = entries
    .filter(([, fact]) => fact.disposition === "supported")
    .map(([factKey]) => factKey);
  const gaps = entries
    .filter((entry): entry is [string, Exclude<V9MechanismProfileFact, { disposition: "supported" }>] =>
      entry[1].disposition !== "supported",
    )
    .map(([factKey, fact]) => ({ factKey, responsibility: fact.disposition }));
  return {
    profile: review.profile,
    complete: gaps.length === 0,
    supportedFactKeys,
    gaps,
  };
}

export function projectV9MechanismProfile(
  input: V9MechanismProfileReview,
): V9MechanismProfileProjection {
  const review = V9MechanismProfileReviewSchema.parse(input);
  if (review.profile === "allocated-commodity-claim") {
    return {
      archetype: "fiat-cash",
      components: {
        claimAndSegregation: combineProfileFacts(review.facts, [
          "holderTitle",
          "physicalAllocation",
          "custodianSegregation",
          "bankruptcyRemoteness",
        ]),
        custodyContinuity: combineProfileFacts(review.facts, ["custodyContinuity", "insurance"]),
        assuranceAndReconciliation: combineProfileFacts(review.facts, [
          "auditCadence",
          "reserveReconciliation",
        ]),
      },
      metrics: {},
      exitFacts: { physicalRedemption: review.facts.physicalRedemption },
    };
  }
  return {
    archetype: "algorithmic",
    components: {
      contractionCapacity: combineProfileFacts(review.facts, [
        "collateralCoverage",
        "contractionLiquidity",
      ]),
      confidenceAndIncentives: combineProfileFacts(review.facts, ["reflexiveBackstop"]),
      oracleAndControlAssumptions: combineProfileFacts(review.facts, ["indexOracle"]),
      emergencyRecovery: combineProfileFacts(review.facts, ["emergencyRecovery"]),
      lossRecovery: combineProfileFacts(review.facts, ["lossRecovery"]),
    },
    metrics: {
      exogenousBackingShare: review.exogenousBackingShare,
      reflexiveBackingShare: review.reflexiveBackingShare,
      contractionCapacityRatio: review.contractionCapacityRatio,
    },
    exitFacts: { protocolRedemption: review.facts.protocolRedemption },
  };
}
