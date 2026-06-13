import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { SAFETY_SCORE_VERSION } from "@shared/lib/safety-score-version";
import {
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
  GRADE_THRESHOLDS,
} from "@shared/lib/report-cards";
import {
  ACTIVE_DEPEG_SEVERITY_SOURCE,
  ACTIVE_DEPEG_CAP_D_BPS,
  ACTIVE_DEPEG_CAP_D_SCORE,
  ACTIVE_DEPEG_CAP_F_BPS,
  ACTIVE_DEPEG_CAP_F_SCORE,
} from "@shared/lib/report-card-active-depeg";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import type { DependencyGraphEdge } from "@shared/lib/dependency-graph";
import type {
  ReportCard,
  ReportCardGrade,
} from "@shared/types/report-cards";
import type { CollateralDriftEntry } from "./collateral-drift";
import type { ReportCardsInputFreshness } from "./report-cards-snapshot-inputs";

export function buildDefunctReportCards(): ReportCard[] {
  const nrDim = Object.freeze({ grade: "F" as const, score: 0, detail: "Defunct stablecoin" });

  const toDefunctCard = (coin: { id: string; name: string; symbol: string }): ReportCard => ({
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    overallGrade: "F" as const,
    overallScore: 0,
    baseScore: null,
    overallCapped: false,
    uncappedOverallScore: null,
    dimensions: {
      pegStability: nrDim,
      liquidity: nrDim,
      resilience: nrDim,
      decentralization: nrDim,
      dependencyRisk: nrDim,
    },
    ratedDimensions: 5,
    rawInputs: createReportCardRawInputs(),
    isDefunct: true,
  });

  return [...DEAD_STABLECOINS, ...FROZEN_STABLECOINS].map(toDefunctCard);
}

export function sortReportCards(cards: ReportCard[]): ReportCard[] {
  return [...cards].sort((a, b) => {
    if (a.overallScore === null && b.overallScore === null) return 0;
    if (a.overallScore === null) return 1;
    if (b.overallScore === null) return -1;
    return b.overallScore - a.overallScore;
  });
}

export function buildReportCardsSnapshotEnvelope(input: {
  cards: ReportCard[];
  updatedAt: number;
  liquidityStale: boolean;
  redemptionStale: boolean;
  inputFreshness: ReportCardsInputFreshness;
  collateralDriftCoins: CollateralDriftEntry[];
  liveToFallbackCoins: string[];
  dependencyGraphEdges: DependencyGraphEdge[];
}) {
  return {
    cards: input.cards,
    methodology: {
      version: SAFETY_SCORE_VERSION,
      weights: DIMENSION_WEIGHTS,
      pegMultiplierExponent: PEG_MULTIPLIER_EXPONENT,
      activeDepegSeveritySource: ACTIVE_DEPEG_SEVERITY_SOURCE,
      activeDepegCaps: {
        d: { thresholdBps: ACTIVE_DEPEG_CAP_D_BPS, score: ACTIVE_DEPEG_CAP_D_SCORE },
        f: { thresholdBps: ACTIVE_DEPEG_CAP_F_BPS, score: ACTIVE_DEPEG_CAP_F_SCORE },
      },
      thresholds: GRADE_THRESHOLDS as { grade: ReportCardGrade; min: number }[],
    },
    dependencyGraph: { edges: input.dependencyGraphEdges },
    updatedAt: input.updatedAt,
    liquidityStale: input.liquidityStale,
    redemptionStale: input.redemptionStale,
    inputFreshness: input.inputFreshness,
    ...(input.collateralDriftCoins.length > 0 ? { collateralDriftCoins: input.collateralDriftCoins } : {}),
    ...(input.liveToFallbackCoins.length > 0 ? { liveToFallbackCoins: input.liveToFallbackCoins } : {}),
  };
}
