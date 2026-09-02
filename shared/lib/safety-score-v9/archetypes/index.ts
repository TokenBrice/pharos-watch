import {
  createUnknownArchetypeV9BackingResult,
  evaluateV9ArchetypeBacking,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
} from "../backing";
import {
  type V9MechanismFactV1,
  type V9MechanismRiskReview,
} from "../../../types/safety-score-v9-backing";
import { MECHANISM_ARCHETYPE_VALUES } from "../../../types/stablecoin-taxonomy";
import { evaluateV9AlgorithmicBacking } from "./algorithmic";
import { evaluateV9CdpBacking } from "./cdp";
import { evaluateV9RwaCreditFundBacking } from "./rwa-credit-fund";
import { evaluateV9SyntheticDeltaNeutralBacking } from "./synthetic-delta-neutral";


export type { V9MechanismRiskReview } from "../../../types/safety-score-v9-backing";
export { resolveV9MetricApplicability } from "./rwa-credit-fund";

export interface V9UnknownMechanismRiskReview {
  readonly archetype: string;
}

/**
 * Archetypes this dispatcher evaluates. Identical by construction to the
 * `V9MechanismRiskReviewSchema` discriminated-union members — asserted in
 * `shared/lib/__tests__/safety-score-v9-archetypes.test.ts` — so membership is a
 * plain `Set` lookup rather than a walk of Zod's internal `options`/`shape`.
 */
const SUPPORTED_MECHANISM_ARCHETYPES: ReadonlySet<string> = new Set(MECHANISM_ARCHETYPE_VALUES);

type V9SimpleArchetype = "fiat-cash" | "commodity-claim" | "tbill";
type V9SimpleReview = Extract<V9MechanismRiskReview, { archetype: V9SimpleArchetype }>;
type V9MechanismFactKey<T> = {
  [K in keyof T]: T[K] extends V9MechanismFactV1 ? K : never;
}[keyof T];
type V9SimpleArchetypeDescriptor<A extends V9SimpleArchetype> = readonly [
  componentKey: string,
  factKey: V9MechanismFactKey<Extract<V9SimpleReview, { archetype: A }>>,
];

const V9_SIMPLE_ARCHETYPE_DESCRIPTORS: {
  readonly [A in V9SimpleArchetype]: readonly V9SimpleArchetypeDescriptor<A>[];
} = {
  "fiat-cash": [
    ["claim-and-segregation", "claimAndSegregation"],
    ["custody-continuity", "custodyContinuity"],
    ["assurance-and-reconciliation", "assuranceAndReconciliation"],
  ],
  "commodity-claim": [
    ["title-and-allocation", "titleAndAllocation"],
    ["custody-continuity", "custodyContinuity"],
    ["assurance-and-reconciliation", "assuranceAndReconciliation"],
    ["physical-redemption", "physicalRedemption"],
  ],
  tbill: [
    ["fund-claim-and-seniority", "fundClaimAndSeniority"],
    ["nav-valuation", "navValuation"],
    ["duration-and-liquidity", "durationAndLiquidity"],
    ["loss-recovery-design", "lossRecoveryDesign"],
  ],
};

export function evaluateV9SimpleArchetypeBacking(
  asset: V9BackingAssetInput,
  review: V9SimpleReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  // The descriptor table is typed per archetype, so each factKey is a real
  // V9MechanismFactV1 field of its review; the union index below only loses
  // that per-member link, hence the single cast at the read site.
  const facts = review as unknown as Record<string, V9MechanismFactV1>;
  return evaluateV9ArchetypeBacking(
    {
      archetype: review.archetype,
      asset,
      components: V9_SIMPLE_ARCHETYPE_DESCRIPTORS[review.archetype].map(
        ([componentKey, factKey]) => ({ componentKey, fact: facts[factKey] }),
      ),
    },
    policy,
  );
}

function isSupportedMechanismReview(
  review: V9MechanismRiskReview | V9UnknownMechanismRiskReview,
): review is V9MechanismRiskReview {
  return SUPPORTED_MECHANISM_ARCHETYPES.has(review.archetype);
}

export function evaluateV9Backing(
  asset: V9BackingAssetInput,
  review: V9MechanismRiskReview | V9UnknownMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  // Unsupported-archetype fallback stays: an asset whose curated archetype has
  // no evaluator must degrade, never throw.
  if (!isSupportedMechanismReview(review)) {
    return createUnknownArchetypeV9BackingResult(asset.assetId, review.archetype, policy);
  }
  // No re-parse: the review reached here through the compiled fact set, whose
  // `V9MechanismRiskReviewFactV2Schema.review` field is this exact schema.
  switch (review.archetype) {
    case "fiat-cash":
    case "commodity-claim":
    case "tbill":
      return evaluateV9SimpleArchetypeBacking(asset, review, policy);
    case "cdp":
      return evaluateV9CdpBacking(asset, review, policy);
    case "synthetic-delta-neutral":
      return evaluateV9SyntheticDeltaNeutralBacking(asset, review, policy);
    case "algorithmic":
      return evaluateV9AlgorithmicBacking(asset, review, policy);
    case "rwa-credit-fund":
      return evaluateV9RwaCreditFundBacking(asset, review, policy);
  }
}
