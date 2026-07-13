import {
  V9FactGapV2Schema,
  V9TypedFactPathSchema,
  type V9FactGapV2,
  type V9ObservationState,
  type V9TypedFactPath,
} from "../../types/safety-score-v9-facts";
import type { V9ReasonCode, V9ReasonOwnerDomain } from "../../types/safety-score-v9";
import type { DependencyType } from "../../types/dependency-types";

export function serialDependencyV9Path(
  upstreamAssetId: string,
  dependencyType: Extract<DependencyType, "wrapper" | "mechanism">,
): V9TypedFactPath {
  return V9TypedFactPathSchema.parse({ kind: "serial-dependency", upstreamAssetId, dependencyType });
}

export function collateralExposureV9Path(exposureKey: string): V9TypedFactPath {
  return V9TypedFactPathSchema.parse({ kind: "collateral-exposure", exposureKey });
}

export function deploymentControlV9Path(deploymentKey: string, controlKey: string): V9TypedFactPath {
  return V9TypedFactPathSchema.parse({ kind: "deployment-control", deploymentKey, controlKey });
}

export function optionalExitV9Path(routeKey: string): V9TypedFactPath {
  return V9TypedFactPathSchema.parse({ kind: "optional-exit", routeKey });
}

export function createV9FactGap(args: {
  gapId: string;
  reasonCode: V9ReasonCode;
  ownerDomain: V9ReasonOwnerDomain;
  policyRuleId: string;
  observationState: Exclude<V9ObservationState, "known">;
  path: V9TypedFactPath;
  message: string;
  evidenceRefIds?: readonly string[];
}): V9FactGapV2 {
  return V9FactGapV2Schema.parse({
    ...args,
    evidenceRefIds: [...(args.evidenceRefIds ?? [])],
  });
}
