import type {
  BackingType,
  CustodyModel,
  GovernanceType,
  ReserveSlice,
  ReserveRisk,
} from "../types";
import type { StablecoinClientMeta } from "../types/stablecoin-client-meta";
import { roundScore } from "./math";

const DEFAULT_CUSTODY_MODELS: Record<`${BackingType}:${GovernanceType}`, CustodyModel> = {
  "rwa-backed:centralized": "institutional-regulated",
  "rwa-backed:centralized-dependent": "institutional-regulated",
  "rwa-backed:decentralized": "onchain",
  "crypto-backed:centralized": "onchain",
  "crypto-backed:centralized-dependent": "onchain",
  "crypto-backed:decentralized": "onchain",
  "algorithmic:centralized": "onchain",
  "algorithmic:centralized-dependent": "onchain",
  "algorithmic:decentralized": "onchain",
};

const RESERVE_QUALITY_SCORE: Record<ReserveRisk, number> = {
  "very-low": 100,
  low: 75,
  medium: 50,
  high: 25,
  "very-high": 5,
};

export function computeCollateralQualityFromReserves(reserves: ReserveSlice[]): number {
  const totalPct = reserves.reduce((sum, reserve) => sum + reserve.pct, 0);
  if (totalPct === 0) return 0;
  const weighted = reserves.reduce((sum, reserve) => sum + reserve.pct * (RESERVE_QUALITY_SCORE[reserve.risk] ?? 0), 0);
  return roundScore(weighted / totalPct);
}

export function inferDefaultCustodyModel(backing: BackingType, governance: GovernanceType): CustodyModel {
  return DEFAULT_CUSTODY_MODELS[`${backing}:${governance}`];
}

/** Curated custody review first, with the legacy backing/governance table as fallback. */
export function resolveCustodyModel(meta: StablecoinClientMeta): CustodyModel {
  return meta.custodyModel ?? inferDefaultCustodyModel(meta.flags.backing, meta.flags.governance);
}
