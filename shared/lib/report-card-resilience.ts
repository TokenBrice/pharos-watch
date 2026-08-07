import type {
  ChainTier,
  CollateralQuality,
  CustodyModel,
  DeploymentModel,
  ReserveSlice,
  StablecoinMeta,
} from "../types";
import { roundScore } from "./math";
import { RESERVE_QUALITY_SCORE, inferResilienceDefaults } from "./report-card-policy";

export { inferResilienceDefaults } from "./report-card-policy";

export function computeCollateralQualityFromReserves(reserves: ReserveSlice[]): number {
  const totalPct = reserves.reduce((sum, reserve) => sum + reserve.pct, 0);
  if (totalPct === 0) return 0;
  const weighted = reserves.reduce((sum, reserve) => sum + reserve.pct * (RESERVE_QUALITY_SCORE[reserve.risk] ?? 0), 0);
  return roundScore(weighted / totalPct);
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
