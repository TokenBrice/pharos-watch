import {
  V9_WRAPPER_LOCAL_FACT_KEYS,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperFactDisposition,
  type V9WrapperForm,
  type V9WrapperLocalFactKey,
} from "../../types/safety-score-v9-wrapper";
import { assertScore, compareText } from "./primitives";
import type { V9FactGapV3, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import type { V9EvidenceCause, V9ScoringDisposition } from "../../types/safety-score-v9-causes";
import { resolveV9StatusCauses, v9ScoringDisposition } from "./control-primitives";

export type { V9WrapperForm } from "../../types/safety-score-v9-wrapper";

export interface V9WrapperParentLimitInput {
  parentScore: number;
  localFacts: V9ApplicableWrapperLocalFacts;
  formDiscounts: Readonly<Record<V9WrapperForm, number>>;
  gaps?: readonly V9FactGapV3[];
}

export interface V9WrapperMissingFact {
  factClass: V9WrapperLocalFactKey | "wrapperForm";
  disposition: Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable">;
  cause: V9EvidenceCause;
  causeGapIds: readonly string[];
  scoringDisposition: V9ScoringDisposition;
}

export interface V9WrapperParentLimit {
  schemaVersion: 1;
  parentScore: number;
  form: V9WrapperForm;
  appliedDiscount: number;
  limit: number;
  factsComplete: boolean;
  missingFacts: readonly V9WrapperMissingFact[];
}

/** Price the wrapper form once at its premium-free serial-parent ceiling. */
export function resolveV9WrapperParentLimit(input: V9WrapperParentLimitInput): V9WrapperParentLimit {
  assertScore(input.parentScore, "wrapper parent score");
  const form = input.localFacts.form;
  const appliedDiscount = input.formDiscounts[form];
  assertScore(appliedDiscount, "wrapper form deduction");
  const missingFacts: V9WrapperMissingFact[] = [];
  const recordMissing = (
    factClass: V9WrapperMissingFact["factClass"],
    disposition: V9WrapperFactDisposition,
    status?: V9FactStatusV2,
  ) => {
    if (disposition === "reviewed" || disposition === "not-applicable") return;
    const resolved = resolveV9StatusCauses([status], input.gaps);
    const cause = resolved.cause ?? "U";
    missingFacts.push({
      factClass, disposition, cause, causeGapIds: resolved.causeGapIds,
      scoringDisposition: v9ScoringDisposition(cause),
    });
  };
  for (const factKey of V9_WRAPPER_LOCAL_FACT_KEYS) {
    const fact = input.localFacts.facts[factKey];
    recordMissing(factKey, fact.disposition, fact.status);
  }
  recordMissing("wrapperForm", input.localFacts.formDisposition, input.localFacts.formStatus);
  missingFacts.sort((left, right) =>
    compareText(left.factClass, right.factClass) || compareText(left.disposition, right.disposition),
  );
  return {
    schemaVersion: 1,
    parentScore: input.parentScore,
    form,
    appliedDiscount,
    limit: Math.max(0, Math.floor(input.parentScore - appliedDiscount)),
    factsComplete: missingFacts.length === 0,
    missingFacts,
  };
}
