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
import { activeDepegCapScore } from "./report-card-active-depeg";
import { scoreDependencyRisk } from "./report-card-dependency";

interface OverallComputation {
  grade: ReportCardGrade;
  score: number | null;
  baseScore: number | null;
  ratedDimensions: number;
}

export function computeOverallGrade(
  dimensions: Record<DimensionKey, ReportCardDimension>,
  options?: { navToken?: boolean; activeDepegBps?: number | null },
): OverallComputation {
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

  const capScore = activeDepegCapScore(options?.activeDepegBps);
  if (capScore != null) {
    score = Math.min(score, capScore);
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const ratedDimensions = baseRatedCount + (pegScore !== null ? 1 : 0);

  return { grade: scoreToGrade(clamped), score: clamped, baseScore, ratedDimensions };
}

export function applyVariantOverallCap(
  overall: OverallComputation,
  parentScore: number | null,
): OverallComputation & { overallCapped: boolean; uncappedOverallScore: number | null } {
  if (overall.score == null || parentScore == null || overall.score <= parentScore) {
    return {
      ...overall,
      overallCapped: false,
      uncappedOverallScore: null,
    };
  }

  return {
    ...overall,
    grade: scoreToGrade(parentScore),
    score: parentScore,
    overallCapped: true,
    uncappedOverallScore: overall.score,
  };
}

export function computeStressedGrades(
  cards: ReportCard[],
  overrides: Map<string, number>,
): ReportCard[] {
  const cardById = new Map(cards.map((card) => [card.id, card]));
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
  const dependentsByUpstream = new Map<string, string[]>();
  for (const card of cards) {
    for (const dependency of card.rawInputs.dependencies) {
      const existing = dependentsByUpstream.get(dependency.id);
      if (existing) {
        existing.push(card.id);
      } else {
        dependentsByUpstream.set(dependency.id, [card.id]);
      }
    }
  }

  const affectedIds = new Set<string>();
  const queue = [...overriddenIds];
  for (let index = 0; index < queue.length; index += 1) {
    const upstreamId = queue[index];
    for (const dependentId of dependentsByUpstream.get(upstreamId) ?? []) {
      if (overriddenIds.has(dependentId) || affectedIds.has(dependentId)) continue;
      affectedIds.add(dependentId);
      queue.push(dependentId);
    }
  }

  const recomputeOrder: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visitAffected(id: string): void {
    if (visited.has(id) || !affectedIds.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    const card = cardById.get(id);
    if (card) {
      for (const dependency of card.rawInputs.dependencies) {
        visitAffected(dependency.id);
      }
    }
    visiting.delete(id);
    visited.add(id);
    recomputeOrder.push(id);
  }

  for (const id of affectedIds) {
    visitAffected(id);
  }

  const updatedCards = new Map<string, ReportCard>();
  for (const card of cards) {
    const override = overrides.get(card.id);
    if (override !== undefined) {
      const capped = applyVariantOverallCap(
        {
          grade: scoreToGrade(override),
          score: override,
          baseScore: card.baseScore,
          ratedDimensions: card.ratedDimensions,
        },
        card.rawInputs.variantParentId != null
          ? (overallScores.get(card.rawInputs.variantParentId) ?? null)
          : null,
      );
      updatedCards.set(card.id, {
        ...card,
        overallGrade: capped.grade,
        overallScore: capped.score,
        baseScore: capped.baseScore,
        overallCapped: capped.overallCapped,
        uncappedOverallScore: capped.uncappedOverallScore,
      });
      if (capped.score !== null) {
        overallScores.set(card.id, capped.score);
      } else {
        overallScores.delete(card.id);
      }
    }
  }

  for (const id of recomputeOrder) {
    const card = cardById.get(id);
    if (!card) continue;
    const dependencyRisk = scoreDependencyRisk({
      governance: card.rawInputs.governanceTier,
      dependencies: card.rawInputs.dependencies,
      variantParentId: card.rawInputs.variantParentId ?? null,
      variantKind: card.rawInputs.variantKind ?? null,
    }, overallScores);
    const dimensions = { ...card.dimensions, dependencyRisk };
    const overall = applyVariantOverallCap(
      computeOverallGrade(dimensions, {
        navToken: card.rawInputs.navToken,
        activeDepegBps: card.rawInputs.activeDepegBps ?? null,
      }),
      card.rawInputs.variantParentId != null
        ? (overallScores.get(card.rawInputs.variantParentId) ?? null)
        : null,
    );
    const updated = {
      ...card,
      dimensions,
      overallGrade: overall.grade,
      overallScore: overall.score,
      baseScore: overall.baseScore,
      ratedDimensions: overall.ratedDimensions,
      overallCapped: overall.overallCapped,
      uncappedOverallScore: overall.uncappedOverallScore,
    };
    updatedCards.set(card.id, updated);
    if (overall.score !== null) {
      overallScores.set(card.id, overall.score);
    } else {
      overallScores.delete(card.id);
    }
  }

  return cards.map((card) => updatedCards.get(card.id) ?? card);
}
