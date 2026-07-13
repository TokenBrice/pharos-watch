import {
  createUnknownArchetypeV9BackingResult,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
} from "../backing";
import { V9MechanismRiskReviewSchema, type V9MechanismRiskReview } from "../../../types/safety-score-v9-backing";
import { evaluateV9AlgorithmicBacking } from "./algorithmic";
import { evaluateV9CdpBacking } from "./cdp";
import { evaluateV9FiatCashBacking } from "./fiat-cash";
import { evaluateV9RwaCreditFundBacking } from "./rwa-credit-fund";
import { evaluateV9SyntheticDeltaNeutralBacking } from "./synthetic-delta-neutral";
import { evaluateV9TbillBacking } from "./tbill";

export type { V9AlgorithmicMechanismRiskReview } from "./algorithmic";
export type { V9CdpMechanismRiskReview } from "./cdp";
export type { V9FiatCashMechanismRiskReview } from "./fiat-cash";
export type { V9RwaCreditFundMechanismRiskReview } from "./rwa-credit-fund";
export type { V9SyntheticDeltaNeutralMechanismRiskReview, V9SyntheticVenueShare } from "./synthetic-delta-neutral";
export type { V9TbillMechanismRiskReview } from "./tbill";

export type { V9MechanismRiskReview } from "../../../types/safety-score-v9-backing";

export interface V9UnknownMechanismRiskReview {
  readonly archetype: string;
}

export function evaluateV9Backing(
  asset: V9BackingAssetInput,
  review: V9MechanismRiskReview | V9UnknownMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  const isSupported = V9MechanismRiskReviewSchema.options.some(
    (schema) => schema.shape.archetype.value === review.archetype,
  );
  if (!isSupported) return createUnknownArchetypeV9BackingResult(asset.assetId, review.archetype, policy);
  const normalized = V9MechanismRiskReviewSchema.parse(review);
  switch (normalized.archetype) {
    case "fiat-cash":
      return evaluateV9FiatCashBacking(asset, normalized, policy);
    case "tbill":
      return evaluateV9TbillBacking(asset, normalized, policy);
    case "cdp":
      return evaluateV9CdpBacking(asset, normalized, policy);
    case "synthetic-delta-neutral":
      return evaluateV9SyntheticDeltaNeutralBacking(asset, normalized, policy);
    case "algorithmic":
      return evaluateV9AlgorithmicBacking(asset, normalized, policy);
    case "rwa-credit-fund":
      return evaluateV9RwaCreditFundBacking(asset, normalized, policy);
  }
}
