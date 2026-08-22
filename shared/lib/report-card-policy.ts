import type {
  BackingType,
  CollateralQuality,
  CustodyModel,
  GovernanceType,
  ReserveSlice,
  ReserveRisk,
} from "../types";
import type { StablecoinClientMeta } from "../types/stablecoin-client-meta";
import { roundScore } from "./math";

type ResilienceDefaults = {
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
};

const DEFAULT_RESILIENCE_FACTORS: Record<`${BackingType}:${GovernanceType}`, ResilienceDefaults> = {
  "rwa-backed:centralized": {
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
  },
  "rwa-backed:centralized-dependent": {
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
  },
  "rwa-backed:decentralized": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "crypto-backed:centralized": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "crypto-backed:centralized-dependent": {
    collateralQuality: "eth-lst",
    custodyModel: "onchain",
  },
  "crypto-backed:decentralized": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:centralized": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:centralized-dependent": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:decentralized": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
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

export function inferResilienceDefaults(backing: BackingType, governance: GovernanceType): ResilienceDefaults {
  return DEFAULT_RESILIENCE_FACTORS[`${backing}:${governance}`];
}

/** Curated custody review first, with the legacy backing/governance table as fallback. */
export function resolveCustodyModel(meta: StablecoinClientMeta): CustodyModel {
  return meta.custodyModel ?? inferResilienceDefaults(
    meta.flags.backing,
    meta.flags.governance,
  ).custodyModel;
}
