import { uniqueSorted } from "@shared/lib/safety-score-v9/primitives";
import type { V9AssetFactsV2, V9EffectiveDependenciesV3 } from "@shared/types/safety-score-v9-facts";
import {
  V9WrapperLocalFactsSchema,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperLocalFacts,
} from "@shared/types/safety-score-v9-wrapper";
import {
  componentResearchEvidence,
  fallbackResearchEvidence,
  type AssetBuildContext,
} from "./fact-set-context";

interface WrapperLocalFactBuildInputs {
  implementation: V9AssetFactsV2["implementation"];
  dependencies: V9EffectiveDependenciesV3;
}

export function resolveWrapperForm(
  asset: AssetBuildContext["asset"],
  dependencies?: V9EffectiveDependenciesV3,
): V9ApplicableWrapperLocalFacts["form"] | null {
  if (asset.variantKind === "pure-wrapper") return "pure";
  if (asset.variantKind === "savings-passthrough") return "native-staked";
  if (asset.variantKind === "risk-absorption") {
    return asset.wrapperOperator === "third-party" ? "strategy-vault" : "native-staked";
  }
  if (
    asset.variantKind === "strategy-vault" ||
    dependencies?.edges.some(
      (edge) => edge.pathKind === "serial-dependency" && edge.dependencyType === "wrapper",
    )
  ) return "strategy-vault";
  return null;
}

/** Wrapper pricing needs only its evidenced form; local risks stay in their pillars. */
export function buildWrapperLocalFacts(
  context: AssetBuildContext,
  input: WrapperLocalFactBuildInputs,
): V9WrapperLocalFacts {
  const wrapperEdge = input.dependencies.edges.find(
    (edge) => edge.pathKind === "serial-dependency" && edge.dependencyType === "wrapper",
  );
  const form = resolveWrapperForm(context.asset, input.dependencies);
  const evidenceRefIds = uniqueSorted([
    ...input.implementation.status.evidenceRefIds,
    ...input.dependencies.status.evidenceRefIds,
    ...(wrapperEdge?.evidenceRefIds ?? []),
  ]);
  const formEvidenceRefIds = evidenceRefIds.length > 0 ? evidenceRefIds : [fallbackResearchEvidence(context)];
  if (form === null) {
    return V9WrapperLocalFactsSchema.parse({ schemaVersion: 1, applicability: "not-wrapper", evidenceRefIds: formEvidenceRefIds });
  }
  return V9WrapperLocalFactsSchema.parse({
    schemaVersion: 1,
    applicability: "wrapper",
    form,
    formDisposition: "reviewed",
    formSignals: [
      `wrapper-form:${form}`,
      `wrapper-form-source:${context.asset.variantKind ?? "serial-wrapper-dependency"}`,
      ...(context.asset.wrapperOperator === undefined ? [] : [`wrapper-operator:${context.asset.wrapperOperator}`]),
    ],
    formEvidenceRefIds,
    ...(context.asset.parentBackingInheritance === undefined ? {} : {
      parentBackingInheritance: {
        state: context.asset.parentBackingInheritance.state,
        reason: context.asset.parentBackingInheritance.reason,
        evidenceRefIds: componentResearchEvidence(context, "wrapper-local:parentBackingInheritance"),
      },
    }),
  });
}
