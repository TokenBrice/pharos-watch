import type {
  DependencyType,
  GovernanceType,
  ReportCardDimension,
  ReportCardDetailItem,
  DependencyWeight,
  VariantKind,
} from "../types";
import { scoreToGrade } from "./report-card-core";
import { joinReportCardDetail, labeledDetailItem, plural } from "./report-card-detail";
import { wrapperPenaltyForVariant } from "./report-card-wrapper-penalty";
import { roundScore } from "./math";

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
      detailItems: [{ label: "Self-backed", value: GOVERNANCE_DETAIL_LABEL[governance], detail: `${selfScore}` }],
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
      detailItems: [{ label: "Upstream", value: "Dependency scores unavailable" }],
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
  const blendedScore =
    resolved.reduce((sum, dependency) => sum + dependency.score * (dependency.weight / normalizer), 0) +
    selfBackedFraction * selfBackedScore;

  let score = blendedScore;
  const weakDependencies = resolved.filter((dependency) => dependency.score < 75);
  if (weakDependencies.length > 0) {
    score -= 10;
  }

  let ceiling = Infinity;
  let ceilingDepType: "wrapper" | "mechanism" | null = null;
  for (const dependency of resolved) {
    if (dependency.type === "wrapper") {
      const wrapperPenalty =
        args.variantParentId != null && args.variantKind != null && dependency.id === args.variantParentId
          ? wrapperPenaltyForVariant(args.variantKind)
          : wrapperPenaltyForVariant();
      const candidate = dependency.score - wrapperPenalty;
      if (candidate < ceiling) {
        ceiling = candidate;
        ceilingDepType = "wrapper";
      }
    } else if (dependency.type === "mechanism") {
      if (dependency.score < ceiling) {
        ceiling = dependency.score;
        ceilingDepType = "mechanism";
      }
    }
  }
  if (ceiling < Infinity) {
    score = Math.min(score, ceiling);
  }

  score = roundScore(score);

  const detailItems: ReportCardDetailItem[] = [];
  detailItems.push(
    labeledDetailItem(
      "Upstream",
      `${plural(resolved.length, "upstream dep")} (${Math.round(totalWeight * 100)}% weight) (${Math.round(blendedScore)})`,
    ),
  );
  detailItems.push(
    labeledDetailItem("Declared dependency weight", `${Math.round(Math.min(1, declaredWeight) * 100)}%`),
  );
  if (missingDependencies.length > 0) {
    detailItems.push(
      labeledDetailItem(
        "Unavailable upstream scores",
        `${plural(missingDependencies.length, "dep")} (${Math.round(missingWeight * 100)}% weight, scored at ${UNAVAILABLE_DEPENDENCY_SCORE})`,
      ),
    );
  }
  if (resolvedWeight !== rawTotal) {
    detailItems.push(labeledDetailItem("Resolved upstream weight", `${Math.round(resolvedWeight * 100)}%`));
  }
  detailItems.push(labeledDetailItem("Self-backed", `${GOVERNANCE_DETAIL_LABEL[governance]} (${selfBackedScore})`));
  if (weakDependencies.length > 0) {
    detailItems.push(labeledDetailItem("Penalty", `${plural(weakDependencies.length, "weak dep")} below 75 (-10)`));
  }
  if (ceiling < Infinity) {
    const ceilingType = ceilingDepType === "wrapper" ? "wrapper" : "mechanism-critical";
    detailItems.push(labeledDetailItem("Ceiling", `${ceilingType} dependency ceiling (${Math.round(ceiling)})`));
  }

  return { grade: scoreToGrade(score), score, detail: joinReportCardDetail(detailItems), detailItems };
}
