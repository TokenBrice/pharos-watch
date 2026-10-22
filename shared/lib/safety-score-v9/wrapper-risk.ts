import type { V9ApplicableWrapperLocalFacts, V9WrapperForm } from "../../types/safety-score-v9-wrapper";
import type { V9FactStatusV2, V9ReserveExposureFactV2 } from "../../types/safety-score-v9-facts";
import type { V9ResolvedDependencyInputs } from "./dependencies";
import { V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT } from "./backing-inheritance";
import { assertScore } from "./primitives";

export type { V9WrapperForm } from "../../types/safety-score-v9-wrapper";

export interface V9WrapperParentLimitInput {
  parentScore: number;
  localFacts: Pick<V9ApplicableWrapperLocalFacts, "form">;
  formDiscounts: Readonly<Record<V9WrapperForm, number>>;
}


export interface V9WrapperParentLimit {
  schemaVersion: 1;
  parentKind?: "serial" | "concentrated-collateral";
  parentAssetId?: string;
  parentScore: number;
  form: V9WrapperForm;
  appliedDiscount: number;
  limit: number;
}

/** Price the wrapper form once at its premium-free serial-parent ceiling. */
export function resolveV9WrapperParentLimit(input: V9WrapperParentLimitInput): V9WrapperParentLimit {
  assertScore(input.parentScore, "wrapper parent score");
  const form = input.localFacts.form;
  const appliedDiscount = input.formDiscounts[form];
  assertScore(appliedDiscount, "wrapper form deduction");
  return {
    schemaVersion: 1,
    parentScore: input.parentScore,
    form,
    appliedDiscount,
    limit: Math.max(0, Math.floor(input.parentScore - appliedDiscount)),
  };
}

/** Only admitted collateral weights establish a concentrated parent claim. */
export function resolveV9SingleCollateralParent(
  status: V9FactStatusV2,
  inputs: V9ResolvedDependencyInputs,
  exposures: readonly V9ReserveExposureFactV2[],
): V9ResolvedDependencyInputs["basket"][number] | undefined {
  if (inputs.cycleBlocked || status.applicability.state !== "required" ||
      status.observationState !== "known" || status.evidenceRefIds.length === 0) return undefined;
  return inputs.basket.find((parent) =>
    parent.weight >= V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT &&
    exposures.reduce((weight, exposure) => weight + (
      exposure.trackedAssetId === parent.upstreamAssetId &&
      (exposure.assetClass === "stablecoin" || exposure.assetClass === "fund-share") &&
      exposure.status.applicability.state === "required" &&
      exposure.status.observationState === "known" &&
      exposure.status.evidenceRefIds.length > 0 &&
      (exposure.factorStatuses?.assetClass?.observationState ?? "known") === "known" &&
      exposure.factorStatuses?.assetClass?.applicability.state !== "unresolved"
        ? exposure.weight : 0
    ), 0) >= V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT);
}
