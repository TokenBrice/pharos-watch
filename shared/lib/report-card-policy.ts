import type {
  BackingType,
  ChainTier,
  CollateralQuality,
  CustodyModel,
  DeploymentModel,
  GovernanceQuality,
  GovernanceType,
} from "../types";

type ResilienceDefaults = {
  chainTier: ChainTier;
  deploymentModel: DeploymentModel;
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
};

const DEFAULT_RESILIENCE_FACTORS: Record<`${BackingType}:${GovernanceType}`, ResilienceDefaults> = {
  "rwa-backed:centralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
  },
  "rwa-backed:centralized-dependent": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
  },
  "rwa-backed:decentralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "crypto-backed:centralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "crypto-backed:centralized-dependent": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "eth-lst",
    custodyModel: "onchain",
  },
  "crypto-backed:decentralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:centralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:centralized-dependent": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:decentralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
};

const DEFAULT_GOVERNANCE_QUALITY: Record<GovernanceType, GovernanceQuality> = {
  decentralized: "dao-governance",
  "centralized-dependent": "multisig",
  centralized: "single-entity",
};

export function inferResilienceDefaults(
  backing: BackingType,
  governance: GovernanceType,
): ResilienceDefaults {
  return DEFAULT_RESILIENCE_FACTORS[`${backing}:${governance}`];
}

export function inferGovernanceQuality(governance: GovernanceType): GovernanceQuality {
  return DEFAULT_GOVERNANCE_QUALITY[governance];
}
