import { buildDependencyGraphEdges } from "@shared/lib/dependency-graph";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  METHODOLOGY_VERSION,
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
import type { StablecoinMeta } from "@shared/types/core";
import type {
  ReportCard,
  ReportCardGrade,
} from "@shared/types/report-cards";
import type { CollateralDriftEntry } from "./collateral-drift";
import type { ReportCardsInputFreshness } from "./report-cards-snapshot-inputs";

export function buildDefunctReportCards(): ReportCard[] {
  return DEAD_STABLECOINS.map((dead) => {
    const nrDim = { grade: "F" as const, score: 0, detail: "Defunct stablecoin" };
    return {
      id: dead.id,
      name: dead.name,
      symbol: dead.symbol,
      overallGrade: "F" as const,
      overallScore: 0,
      baseScore: null,
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
    };
  });
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
}) {
  return {
    cards: input.cards,
    methodology: {
      version: METHODOLOGY_VERSION,
      weights: DIMENSION_WEIGHTS,
      pegMultiplierExponent: PEG_MULTIPLIER_EXPONENT,
      activeDepegSeveritySource: ACTIVE_DEPEG_SEVERITY_SOURCE,
      activeDepegCaps: {
        d: { thresholdBps: ACTIVE_DEPEG_CAP_D_BPS, score: ACTIVE_DEPEG_CAP_D_SCORE },
        f: { thresholdBps: ACTIVE_DEPEG_CAP_F_BPS, score: ACTIVE_DEPEG_CAP_F_SCORE },
      },
      thresholds: GRADE_THRESHOLDS as { grade: ReportCardGrade; min: number }[],
    },
    dependencyGraph: { edges: buildDependencyGraphEdges(ACTIVE_STABLECOINS as StablecoinMeta[]) },
    updatedAt: input.updatedAt,
    liquidityStale: input.liquidityStale,
    redemptionStale: input.redemptionStale,
    inputFreshness: input.inputFreshness,
    ...(input.collateralDriftCoins.length > 0 ? { collateralDriftCoins: input.collateralDriftCoins } : {}),
    ...(input.liveToFallbackCoins.length > 0 ? { liveToFallbackCoins: input.liveToFallbackCoins } : {}),
  };
}
