import type {
  ChainTier,
  CollateralQuality,
  CustodyModel,
  DeploymentModel,
  ReportCardDimension,
  ReserveRisk,
  ReserveSlice,
  StablecoinMeta,
} from "../types";
import { scoreToGrade } from "./report-card-core";
import { inferResilienceDefaults } from "./report-card-policy";
import {
  getBlacklistStatusLabel,
  type BlacklistStatus,
} from "./report-card-blacklist-risk";

export { inferResilienceDefaults } from "./report-card-policy";

const CHAIN_TIER_SCORE: Record<ChainTier, number> = {
  ethereum: 100,
  "stage1-l2": 66,
  "mature-alt-l1": 45,
  "established-alt-l1": 20,
  unproven: 0,
};

const DEPLOYMENT_MULT: Record<DeploymentModel, number> = {
  "single-chain": 1.0,
  "canonical-bridge": 0.9,
  "native-multichain": 0.75,
  "third-party-bridge": 0.6,
};

const COLLATERAL_QUALITY_SCORE: Record<CollateralQuality, number> = {
  native: 100,
  rwa: 50,
  "eth-lst": 66,
  "alt-lst-bridged-or-mixed": 20,
  exotic: 0,
};

const RESERVE_QUALITY_SCORE: Record<ReserveRisk, number> = {
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

const CUSTODY_MODEL_SCORE: Record<CustodyModel, number> = {
  onchain: 100,
  "institutional-top": 80,
  "institutional-regulated": 55,
  "institutional-unregulated": 30,
  "institutional-sanctioned": 5,
  cex: 0,
};

const CHAIN_TIER_LABEL: Record<ChainTier, string> = {
  ethereum: "Ethereum mainnet",
  "stage1-l2": "Stage 1+ L2",
  "mature-alt-l1": "Mature alt-L1",
  "established-alt-l1": "Established alt-L1",
  unproven: "Unproven chain",
};

const DEPLOYMENT_MODEL_LABEL: Record<DeploymentModel, string> = {
  "single-chain": "",
  "canonical-bridge": "canonical bridge",
  "third-party-bridge": "third-party bridge",
  "native-multichain": "native multichain",
};

const COLLATERAL_QUALITY_LABEL: Record<CollateralQuality, string> = {
  native: "Native assets (ETH/BTC)",
  rwa: "Real-world assets (off-chain)",
  "eth-lst": "Ethereum LSTs",
  "alt-lst-bridged-or-mixed": "Alt-L1 LSTs / Bridged / Mixed",
  exotic: "Exotic / opaque strategy",
};

const CUSTODY_MODEL_LABEL: Record<CustodyModel, string> = {
  onchain: "Fully on-chain",
  "institutional-top": "Top-tier custodian",
  "institutional-regulated": "Regulated custodian",
  "institutional-unregulated": "Unregulated custodian",
  "institutional-sanctioned": "Sanctioned custodian",
  cex: "CEX / off-exchange custody",
};

export function computeCollateralQualityFromReserves(reserves: ReserveSlice[]): number {
  const totalPct = reserves.reduce((sum, reserve) => sum + reserve.pct, 0);
  if (totalPct === 0) return 0;
  const weighted = reserves.reduce(
    (sum, reserve) => sum + reserve.pct * (RESERVE_QUALITY_SCORE[reserve.risk] ?? 0),
    0,
  );
  return Math.round(weighted / totalPct);
}

function collateralScoreLabel(score: number): string {
  for (const [threshold, label] of COLLATERAL_QUALITY_DISPLAY) {
    if (score >= threshold) return label;
  }
  return "Very high risk";
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
  const parts = [
    `Collateral: ${collateralLabel} (${collateralScore})`,
    `Custody: ${CUSTODY_MODEL_LABEL[factors.custodyModel]} (${custodyScore})`,
    `Blacklist: ${blacklistLabel} (descriptive only)`,
  ];

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}
