import {
  applyV9MeasuredCollateralization,
  createUnavailableV9BackingResult,
  evaluateV9ArchetypeBacking,
} from "./evaluation";
import {
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
} from "../backing-primitives";
import {
  type V9MechanismFactV1,
  type V9MechanismRiskReview,
} from "../../../types/safety-score-v9-backing";
import { MECHANISM_ARCHETYPE_VALUES } from "../../../types/stablecoin-taxonomy";
import { evaluateV9AlgorithmicBacking } from "./algorithmic";
import { evaluateV9CdpBacking } from "./cdp";
import { evaluateV9RwaCreditFundBacking } from "./rwa-credit-fund";
import { evaluateV9SyntheticDeltaNeutralBacking } from "./synthetic-delta-neutral";
import { V9_MECHANISM_FIELDS, type V9SimpleReview } from "../mechanism-fields";


export type { V9MechanismRiskReview } from "../../../types/safety-score-v9-backing";

export interface V9UnknownMechanismRiskReview {
  readonly archetype: string;
}

/**
 * Archetypes this dispatcher evaluates. Identical by construction to the
 * `V9MechanismRiskReviewSchema` discriminated-union members — asserted in
 * `worker/src/lib/__tests__/safety-score-v9-extension-mechanism.test.ts` — so
 * membership is a plain `Set` lookup rather than Zod `options`/`shape` access.
 */
const SUPPORTED_MECHANISM_ARCHETYPES: ReadonlySet<string> = new Set(MECHANISM_ARCHETYPE_VALUES);


function evaluateV9SimpleArchetypeBacking(
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
      components: V9_MECHANISM_FIELDS[review.archetype].components.map(
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
  // An unsupported mechanism cannot establish a scored subject by itself.
  // Preserve any actual reserves and bound only their missing mechanism.
  if (!isSupportedMechanismReview(review)) {
    return createUnavailableV9BackingResult(asset, {
      archetype: "unresolved",
      mechanismRiskReview: {
        review: null,
        status: {
          applicability: { state: "required", policyRuleId: "v9.backing.archetype", rationale: null, gapId: null },
          observationState: "unsupported",
          evidenceRefIds: [],
          gapIds: [],
        },
      },
    }, policy);
  }
  // No re-parse: the review reached here through the compiled fact set, whose
  // `V9MechanismRiskReviewFactV2Schema.review` field is this exact schema.
  return applyV9MeasuredCollateralization(
    evaluateReviewedBacking(asset, review, policy),
    review.collateralizationMeasurement,
    policy,
    asset.asOfSec,
  );
}

function evaluateReviewedBacking(
  asset: V9BackingAssetInput,
  review: V9MechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  switch (review.archetype) {
    case "fiat-cash":
    case "commodity-claim":
    case "tbill":
    case "ucits-trs-fund":
    case "shared-reserve":
    case "protocol-position":
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
