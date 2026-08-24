import {
  V9FactGapV2Schema,
  V9FactGapV3Schema,
  V9TypedFactPathSchema,
  type V9EvidenceReferenceV2,
  type V9EvidenceResponsibility,
  type V9FactGapV2,
  type V9FactGapV3,
  type V9ObservationState,
  type V9TypedFactPath,
} from "../../types/safety-score-v9-facts";
import type { V9ReasonCode, V9ReasonOwnerDomain } from "../../types/safety-score-v9";
import type { DependencyType } from "../../types/dependency-types";
import { compareText } from "./primitives";
import {
  resolveV9EvidenceResponsibility,
  type V9PublishedEvidenceAttribution,
} from "./evidence";

export interface V9PublicReason {
  code: V9ReasonCode;
  path: string;
  message: string;
  responsibility: V9EvidenceResponsibility;
  sourceGapId?: string | null;
}

export interface V9CanonicalReasonOptions {
  dedupeSourceGapIds?: boolean;
  conflictSubject?: string;
}

/** Canonicalize public reason identity at the evaluator/scorer seam. */
export function canonicalizeV9PublicReasons<T extends V9PublicReason>(
  reasons: readonly T[],
  options: V9CanonicalReasonOptions = {},
): T[] {
  const canonical = [
    ...new Map(
      [...reasons]
        .sort(
          (left, right) =>
            compareText(left.code, right.code) ||
            compareText(left.path, right.path) ||
            compareText(left.message, right.message) ||
            compareText(left.responsibility, right.responsibility),
        )
        .map((reason) => [
          `${reason.code}\u0000${reason.path}\u0000${reason.message}\u0000${reason.responsibility}`,
          reason,
        ]),
    ).values(),
  ];
  const byPublicIdentity = new Map<string, T>();
  const sourceGapIds = new Set<string>();
  for (const reason of canonical) {
    if (options.dedupeSourceGapIds && reason.sourceGapId != null) {
      if (sourceGapIds.has(reason.sourceGapId)) continue;
      sourceGapIds.add(reason.sourceGapId);
    }
    const key = `${reason.code}\u0000${reason.path}`;
    const existing = byPublicIdentity.get(key);
    if (existing !== undefined && existing.responsibility !== reason.responsibility) {
      throw new Error(
        `Safety Score v9 ${options.conflictSubject ?? "reason"} ${reason.code} at ${reason.path} has multiple causal owners`,
      );
    }
    if (existing === undefined) byPublicIdentity.set(key, reason);
  }
  return [...byPublicIdentity.values()];
}

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

export function createV9FactGapV3(args: {
  gapId: string;
  reasonCode: V9ReasonCode;
  ownerDomain: V9ReasonOwnerDomain;
  policyRuleId: string;
  observationState: Exclude<V9ObservationState, "known">;
  responsibility: V9EvidenceResponsibility;
  path: V9TypedFactPath;
  message: string;
  evidenceRefIds?: readonly string[];
  evidenceHistory?: {
    publishedBy: V9PublishedEvidenceAttribution;
    references: readonly V9EvidenceReferenceV2[];
  };
}): V9FactGapV3 {
  const { evidenceHistory, responsibility, ...gap } = args;
  const evidenceRefIds = [...(args.evidenceRefIds ?? [])];
  return V9FactGapV3Schema.parse({
    ...gap,
    responsibility: evidenceHistory === undefined
      ? responsibility
      : resolveV9EvidenceResponsibility({
          observationState: args.observationState,
          fallbackResponsibility: responsibility,
          evidenceReferences: evidenceHistory.references.filter((reference) =>
            evidenceRefIds.includes(reference.evidenceId)),
          publishedBy: evidenceHistory.publishedBy,
        }),
    evidenceRefIds,
  });
}
