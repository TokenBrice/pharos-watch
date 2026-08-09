import {
  createUnknownArchetypeV9BackingResult,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
} from "../backing";
import { type V9MechanismRiskReview } from "../../../types/safety-score-v9-backing";
import { MECHANISM_ARCHETYPE_VALUES } from "../../../types/stablecoin-taxonomy";
import { evaluateV9AlgorithmicBacking } from "./algorithmic";
import { evaluateV9CdpBacking } from "./cdp";
import { evaluateV9CommodityClaimBacking } from "./commodity-claim";
import { evaluateV9FiatCashBacking } from "./fiat-cash";
import { evaluateV9RwaCreditFundBacking } from "./rwa-credit-fund";
import { evaluateV9SyntheticDeltaNeutralBacking } from "./synthetic-delta-neutral";
import { evaluateV9TbillBacking } from "./tbill";

export type { V9AlgorithmicMechanismRiskReview } from "./algorithmic";
export type { V9CdpMechanismRiskReview } from "./cdp";
export type { V9CommodityClaimMechanismRiskReview } from "./commodity-claim";
export type { V9FiatCashMechanismRiskReview } from "./fiat-cash";
export type { V9RwaCreditFundMechanismRiskReview } from "./rwa-credit-fund";
export type { V9SyntheticDeltaNeutralMechanismRiskReview, V9SyntheticVenueShare } from "./synthetic-delta-neutral";
export type { V9TbillMechanismRiskReview } from "./tbill";

export type { V9MechanismRiskReview } from "../../../types/safety-score-v9-backing";

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
      return evaluateV9FiatCashBacking(asset, review, policy);
    case "commodity-claim":
      return evaluateV9CommodityClaimBacking(asset, review, policy);
    case "tbill":
      return evaluateV9TbillBacking(asset, review, policy);
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
