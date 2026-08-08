import type {
  BackingType,
  CollateralQuality,
  CustodyModel,
  GovernanceQuality,
  GovernanceType,
  ReserveRisk,
} from "../types";

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

const DEFAULT_GOVERNANCE_QUALITY: Record<GovernanceType, GovernanceQuality> = {
  decentralized: "dao-governance",
  "centralized-dependent": "multisig",
  centralized: "single-entity",
};

export const RESERVE_QUALITY_SCORE: Record<ReserveRisk, number> = {
  "very-low": 100,
  low: 75,
  medium: 50,
  high: 25,
  "very-high": 5,
};

export function inferResilienceDefaults(backing: BackingType, governance: GovernanceType): ResilienceDefaults {
  return DEFAULT_RESILIENCE_FACTORS[`${backing}:${governance}`];
}

export function inferGovernanceQuality(governance: GovernanceType): GovernanceQuality {
  return DEFAULT_GOVERNANCE_QUALITY[governance];
}
