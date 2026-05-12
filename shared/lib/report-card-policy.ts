import type {
  BackingType,
  ChainTier,
  CollateralQuality,
  CustodyModel,
  DeploymentModel,
  GovernanceQuality,
  GovernanceType,
  ReserveRisk,
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

export const CHAIN_TIER_SCORE: Record<ChainTier, number> = {
  ethereum: 100,
  "stage1-l2": 66,
  "mature-alt-l1": 45,
  "established-alt-l1": 20,
  unproven: 0,
};

export const DEPLOYMENT_MULT: Record<DeploymentModel, number> = {
  "single-chain": 1.0,
  "canonical-bridge": 0.9,
  "native-multichain": 0.75,
  "third-party-bridge": 0.6,
};

export const COLLATERAL_QUALITY_SCORE: Record<CollateralQuality, number> = {
  native: 100,
  rwa: 50,
  "eth-lst": 66,
  "alt-lst-bridged-or-mixed": 20,
  exotic: 0,
};

export const RESERVE_QUALITY_SCORE: Record<ReserveRisk, number> = {
  "very-low": 100,
  low: 75,
  medium: 50,
  high: 25,
  "very-high": 5,
};

const COLLATERAL_QUALITY_DISPLAY: [number, string][] = [
  [88, "Very low risk"],
  [62, "Low risk"],
  [37, "Medium risk"],
  [15, "High risk"],
  [0, "Very high risk"],
];

export const CUSTODY_MODEL_SCORE: Record<CustodyModel, number> = {
  onchain: 100,
  "institutional-top": 80,
  "institutional-regulated": 55,
  "institutional-unregulated": 30,
  "institutional-sanctioned": 5,
  cex: 0,
};

export const CHAIN_TIER_LABEL: Record<ChainTier, string> = {
  ethereum: "Ethereum mainnet",
  "stage1-l2": "Stage 1+ L2",
  "mature-alt-l1": "Mature alt-L1",
  "established-alt-l1": "Established alt-L1",
  unproven: "Unproven chain",
};

export const DEPLOYMENT_MODEL_LABEL: Record<DeploymentModel, string> = {
  "single-chain": "",
  "canonical-bridge": "canonical bridge",
  "third-party-bridge": "third-party bridge",
  "native-multichain": "native multichain",
};

export const COLLATERAL_QUALITY_LABEL: Record<CollateralQuality, string> = {
  native: "Native assets (ETH/BTC)",
  rwa: "Real-world assets (off-chain)",
  "eth-lst": "Ethereum LSTs",
  "alt-lst-bridged-or-mixed": "Alt-L1 LSTs / Bridged / Mixed",
  exotic: "Exotic / opaque strategy",
};

export const CUSTODY_MODEL_LABEL: Record<CustodyModel, string> = {
  onchain: "Fully on-chain",
  "institutional-top": "Top-tier custodian",
  "institutional-regulated": "Regulated custodian",
  "institutional-unregulated": "Unregulated custodian",
  "institutional-sanctioned": "Sanctioned custodian",
  cex: "CEX / off-exchange custody",
};

export function collateralScoreLabel(score: number): string {
  for (const [threshold, label] of COLLATERAL_QUALITY_DISPLAY) {
    if (score >= threshold) return label;
  }
  return "Very high risk";
}

export function inferResilienceDefaults(backing: BackingType, governance: GovernanceType): ResilienceDefaults {
  return DEFAULT_RESILIENCE_FACTORS[`${backing}:${governance}`];
}

export function inferGovernanceQuality(governance: GovernanceType): GovernanceQuality {
  return DEFAULT_GOVERNANCE_QUALITY[governance];
}
