import type {
  DependencyType,
  GovernanceType,
  ReportCardDimension,
  DependencyWeight,
  VariantKind,
} from "../types";
import { scoreToGrade } from "./report-card-core";

const SELF_BACKED_SCORE_BY_GOVERNANCE: Record<GovernanceType, number> = {
  decentralized: 90,
  "centralized-dependent": 75,
  centralized: 95,
};

const GOVERNANCE_DETAIL_LABEL: Record<GovernanceType, string> = {
  decentralized: "Decentralized",
  "centralized-dependent": "Partially centralized",
  centralized: "Centralized",
};

const UNAVAILABLE_DEPENDENCY_SCORE = 70;
const VARIANT_WRAPPER_PENALTY: Record<VariantKind, number> = {
  "savings-passthrough": 3,
  "strategy-vault": 5,
  "risk-absorption": 5,
  "bond-maturity": 8,
};

export interface ScoreDependencyRiskArgs {
  governance: GovernanceType;
  dependencies: DependencyWeight[];
  variantParentId?: string | null;
  variantKind?: VariantKind | null;
}

export function scoreDependencyRisk(
  args: ScoreDependencyRiskArgs,
  overallScores: Map<string, number>,
): ReportCardDimension {
  const { dependencies } = args;
  if (!dependencies || dependencies.length === 0) {
    const governance = args.governance;
    const selfScore = SELF_BACKED_SCORE_BY_GOVERNANCE[governance];
    return {
      grade: scoreToGrade(selfScore),
      score: selfScore,
      detail: `Self-backed: ${GOVERNANCE_DETAIL_LABEL[governance]} (${selfScore})`,
    };
  }

  const resolved: { id: string; weight: number; score: number; type: DependencyType; available: boolean }[] = [];
  const missingDependencies: { id: string; weight: number; type: DependencyType }[] = [];
  for (const dependency of dependencies) {
    const score = overallScores.get(dependency.id);
    if (score !== undefined) {
      resolved.push({
        id: dependency.id,
        weight: dependency.weight,
        score,
        type: dependency.type ?? "collateral",
        available: true,
      });
    } else {
      missingDependencies.push({
        id: dependency.id,
        weight: dependency.weight,
        type: dependency.type ?? "collateral",
      });
    }
  }

  if (resolved.length === 0) {
    return {
      grade: scoreToGrade(UNAVAILABLE_DEPENDENCY_SCORE),
      score: UNAVAILABLE_DEPENDENCY_SCORE,
      detail: "Upstream dependency scores unavailable",
    };
  }

  for (const dependency of missingDependencies) {
    resolved.push({
      ...dependency,
      score: UNAVAILABLE_DEPENDENCY_SCORE,
      available: false,
    });
  }

  const governance = args.governance;
  const selfBackedScore = SELF_BACKED_SCORE_BY_GOVERNANCE[governance];
  const declaredWeight = dependencies.reduce((sum, dependency) => sum + dependency.weight, 0);
  const resolvedWeight = resolved
    .filter((dependency) => dependency.available)
    .reduce((sum, dependency) => sum + dependency.weight, 0);
  const missingWeight = missingDependencies.reduce((sum, dependency) => sum + dependency.weight, 0);
  const rawTotal = resolved.reduce((sum, dependency) => sum + dependency.weight, 0);
  const totalWeight = Math.min(1, rawTotal);
  const selfBackedFraction = 1 - totalWeight;
  const normalizer = rawTotal > 1 ? rawTotal : 1;
  const blendedScore = resolved.reduce(
    (sum, dependency) => sum + dependency.score * (dependency.weight / normalizer),
    0,
  ) + selfBackedFraction * selfBackedScore;

  let score = blendedScore;
  const weakDependencies = resolved.filter((dependency) => dependency.score < 75);
  if (weakDependencies.length > 0) {
    score -= 10;
  }

  let ceiling = Infinity;
  for (const dependency of resolved) {
    if (dependency.type === "wrapper") {
      const wrapperPenalty =
        args.variantParentId != null &&
        args.variantKind != null &&
        dependency.id === args.variantParentId
          ? VARIANT_WRAPPER_PENALTY[args.variantKind]
          : 3;
      ceiling = Math.min(ceiling, dependency.score - wrapperPenalty);
    }
    else if (dependency.type === "mechanism") ceiling = Math.min(ceiling, dependency.score);
  }
  if (ceiling < Infinity) {
    score = Math.min(score, ceiling);
  }

  score = Math.round(Math.max(0, Math.min(100, score)));

  const parts: string[] = [];
  parts.push(
    `Upstream: ${resolved.length} upstream dep${resolved.length === 1 ? "" : "s"} (${Math.round(totalWeight * 100)}% weight) (${Math.round(blendedScore)})`,
  );
  parts.push(`Declared dependency weight: ${Math.round(Math.min(1, declaredWeight) * 100)}%`);
  if (missingDependencies.length > 0) {
    parts.push(
      `Unavailable upstream scores: ${missingDependencies.length} dep${missingDependencies.length === 1 ? "" : "s"} (${Math.round(missingWeight * 100)}% weight, scored at ${UNAVAILABLE_DEPENDENCY_SCORE})`,
    );
  }
  if (resolvedWeight !== rawTotal) {
    parts.push(`Resolved upstream weight: ${Math.round(resolvedWeight * 100)}%`);
  }
  parts.push(`Self-backed: ${GOVERNANCE_DETAIL_LABEL[governance]} (${selfBackedScore})`);
  if (weakDependencies.length > 0) {
    parts.push(`Penalty: ${weakDependencies.length} weak dep${weakDependencies.length === 1 ? "" : "s"} below 75 (-10)`);
  }
  if (ceiling < Infinity) {
    const ceilingType = resolved.some((dependency) => dependency.type === "wrapper")
      ? "wrapper"
      : "mechanism-critical";
    parts.push(`Ceiling: ${ceilingType} dependency ceiling (${Math.round(ceiling)})`);
  }

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}
