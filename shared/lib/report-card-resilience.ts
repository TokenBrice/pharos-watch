import type {
  ChainTier,
  CollateralQuality,
  CustodyModel,
  DeploymentModel,
  ReportCardDimension,
  ReserveSlice,
  ReportCardDetailItem,
  StablecoinMeta,
} from "../types";
import { scoreToGrade } from "./report-card-core";
import { joinReportCardDetail } from "./report-card-detail";
import {
  CHAIN_TIER_LABEL,
  CHAIN_TIER_SCORE,
  COLLATERAL_QUALITY_LABEL,
  COLLATERAL_QUALITY_SCORE,
  CUSTODY_MODEL_LABEL,
  CUSTODY_MODEL_SCORE,
  DEPLOYMENT_MODEL_LABEL,
  DEPLOYMENT_MULT,
  RESERVE_QUALITY_SCORE,
  collateralScoreLabel,
  inferResilienceDefaults,
} from "./report-card-policy";
import { getBlacklistStatusLabel, type BlacklistStatus } from "./report-card-blacklist-risk";

export { inferResilienceDefaults } from "./report-card-policy";

export function computeCollateralQualityFromReserves(reserves: ReserveSlice[]): number {
  const totalPct = reserves.reduce((sum, reserve) => sum + reserve.pct, 0);
  if (totalPct === 0) return 0;
  const weighted = reserves.reduce((sum, reserve) => sum + reserve.pct * (RESERVE_QUALITY_SCORE[reserve.risk] ?? 0), 0);
  return Math.round(weighted / totalPct);
}

export function chainInfraScore(tier: ChainTier, model: DeploymentModel): number {
  return Math.round(CHAIN_TIER_SCORE[tier] * DEPLOYMENT_MULT[model]);
}

export function chainInfraLabel(tier: ChainTier, model: DeploymentModel): string {
  const base = CHAIN_TIER_LABEL[tier];
  const suffix = DEPLOYMENT_MODEL_LABEL[model];
  return suffix ? `${base} (${suffix})` : base;
}

export function resolveResilienceFactors(meta: StablecoinMeta): {
  chainTier: ChainTier;
  deploymentModel: DeploymentModel;
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
} {
  const defaults = inferResilienceDefaults(meta.flags.backing, meta.flags.governance);
  return {
    chainTier: meta.chainTier ?? defaults.chainTier,
    deploymentModel: meta.deploymentModel ?? defaults.deploymentModel,
    collateralQuality: meta.collateralQuality ?? defaults.collateralQuality,
    custodyModel: meta.custodyModel ?? defaults.custodyModel,
  };
}

export function scoreResilience(
  meta: StablecoinMeta,
  canBeBlacklisted: BlacklistStatus,
  liveReserveSlices?: ReserveSlice[],
): ReportCardDimension {
  const factors = resolveResilienceFactors(meta);
  const blacklistLabel = getBlacklistStatusLabel(canBeBlacklisted);

  const custodyScore = CUSTODY_MODEL_SCORE[factors.custodyModel];
  const effectiveReserves = liveReserveSlices ?? meta.reserves;
  const hasReserves = effectiveReserves && effectiveReserves.length > 0;
  const collateralScore = hasReserves
    ? computeCollateralQualityFromReserves(effectiveReserves)
    : COLLATERAL_QUALITY_SCORE[factors.collateralQuality];
  const collateralLabel = hasReserves
    ? collateralScoreLabel(collateralScore)
    : COLLATERAL_QUALITY_LABEL[factors.collateralQuality];

  const score = Math.round((collateralScore + custodyScore) / 2);
  const detailItems: ReportCardDetailItem[] = [
    { label: "Collateral", value: collateralLabel, detail: `${collateralScore}` },
    { label: "Custody", value: CUSTODY_MODEL_LABEL[factors.custodyModel], detail: `${custodyScore}` },
    { label: "Blacklist", value: blacklistLabel, detail: "descriptive only" },
  ];

  return { grade: scoreToGrade(score), score, detail: joinReportCardDetail(detailItems), detailItems };
}
