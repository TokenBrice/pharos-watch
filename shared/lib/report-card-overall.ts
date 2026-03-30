import type {
  DimensionKey,
  ReportCard,
  ReportCardDimension,
  ReportCardGrade,
} from "../types";
import {
  DIMENSION_WEIGHTS,
  NO_LIQUIDITY_PENALTY,
  PEG_MULTIPLIER_EXPONENT,
  scoreToGrade,
} from "./report-card-core";
import { scoreDependencyRisk } from "./report-card-dependency";

export function computeOverallGrade(
  dimensions: Record<DimensionKey, ReportCardDimension>,
  options?: { navToken?: boolean },
): { grade: ReportCardGrade; score: number | null; baseScore: number | null; ratedDimensions: number } {
  const keys = Object.keys(DIMENSION_WEIGHTS) as DimensionKey[];

  let ratedWeight = 0;
  let weightedSum = 0;
  let baseRatedCount = 0;

  for (const key of keys) {
    if (key === "pegStability") continue;
    const dimension = dimensions[key];
    if (dimension.score !== null) {
      ratedWeight += DIMENSION_WEIGHTS[key];
      weightedSum += dimension.score * DIMENSION_WEIGHTS[key];
      baseRatedCount++;
    }
  }

  if (baseRatedCount < 2 || ratedWeight === 0) {
    return { grade: "NR", score: null, baseScore: null, ratedDimensions: baseRatedCount };
  }

  let score = weightedSum / ratedWeight;
  const baseScore = Math.round(score * 10) / 10;

  const pegScore = dimensions.pegStability.score;
  if (pegScore !== null) {
    score *= pegScore === 0 ? 0 : Math.pow(pegScore / 100, PEG_MULTIPLIER_EXPONENT);
  } else if (!options?.navToken) {
    return { grade: "NR", score: null, baseScore: null, ratedDimensions: baseRatedCount };
  }

  if (dimensions.liquidity.score === null) {
    score *= NO_LIQUIDITY_PENALTY;
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const ratedDimensions = baseRatedCount + (pegScore !== null ? 1 : 0);

  return { grade: scoreToGrade(clamped), score: clamped, baseScore, ratedDimensions };
}

export function computeStressedGrades(
  cards: ReportCard[],
  overrides: Map<string, number>,
): ReportCard[] {
  const overallScores = new Map<string, number>();
  for (const card of cards) {
    const override = overrides.get(card.id);
    if (override !== undefined) {
      overallScores.set(card.id, override);
    } else if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
  }

  const overriddenIds = new Set(overrides.keys());
  const affectedIds = new Set<string>();
  for (const card of cards) {
    const dependencies = card.rawInputs.dependencies;
    if (dependencies.length > 0 && dependencies.some((dependency) => overriddenIds.has(dependency.id))) {
      affectedIds.add(card.id);
    }
  }

  return cards.map((card) => {
    if (overriddenIds.has(card.id)) {
      const newScore = overrides.get(card.id)!;
      return {
        ...card,
        overallGrade: scoreToGrade(newScore),
        overallScore: newScore,
        baseScore: card.baseScore,
      };
    }

    if (affectedIds.has(card.id)) {
      const meta = {
        flags: { governance: card.rawInputs.governanceTier },
        dependencies: card.rawInputs.dependencies,
        reserves: undefined,
      };
      const dependencyRisk = scoreDependencyRisk(meta, overallScores);
      const dimensions = { ...card.dimensions, dependencyRisk };
      const overall = computeOverallGrade(dimensions, { navToken: card.rawInputs.navToken });
      return {
        ...card,
        dimensions,
        overallGrade: overall.grade,
        overallScore: overall.score,
        baseScore: overall.baseScore,
        ratedDimensions: overall.ratedDimensions,
      };
    }

    return card;
  });
}
