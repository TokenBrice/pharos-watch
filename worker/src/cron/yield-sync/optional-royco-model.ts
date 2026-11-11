import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import type { YieldMarketStatus, YieldSourceRisk, YieldTrancheSide } from "@shared/types/yield";
import { SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS } from "../../lib/yield/yield-ranking-helpers";
import { normalizeTokenAddress } from "../dex-liquidity/token-resolution";
import type { TrackedOptionalAsset } from "./optional-source-identity";
import type { ResolvedYieldCandidate } from "./types";

const ROYCO_DAWN_MIN_TRANCHE_TVL_USD = 100_000;
const ROYCO_DAWN_MAX_APY_RATIO = 2;

interface RoycoToken {
  symbol?: string | null;
  chainId?: number | null;
  contractAddress?: string | null;
}

interface RoycoVault {
  address?: string | null;
  name?: string | null;
  apy?: number | null;
  apy7d?: number | null;
  apyInfo?: { duration?: { end?: { blockTimestamp?: number | null } } } | null;
  tvl?: {
    tokenAmountUsd?: number | null;
  } | null;
  depositToken?: RoycoToken | null;
  shareToken?: RoycoToken | null;
}

export interface RoycoMarket {
  majorType?: string | null;
  chainId?: number | null;
  marketId?: string | null;
  name?: string | null;
  listingType?: string | null;
  status?: string | null;
  tvlUsd?: number | null;
  coverage?: {
    currentRatio?: number | null;
    requiredRatio?: number | null;
  } | null;
  utilization?: {
    currentRatio?: number | null;
    requiredRatio?: number | null;
  } | null;
  drawdown?: {
    ratio?: number | null;
  } | null;
  totalDrawdowns?: number | null;
  juniorRedemptionDelay?: number | null;
  seniorVault?: RoycoVault | null;
  juniorVault?: RoycoVault | null;
}

function readMarketStatus(value: string | null | undefined): YieldMarketStatus | null {
  return value === "normal" || value === "protected" || value === "unhealthy" || value === "critical" ? value : null;
}

function sourceRiskForTranche(params: {
  side: YieldTrancheSide;
  market: RoycoMarket;
  vault: RoycoVault;
  chain: string;
}): YieldSourceRisk {
  const shareTokenAddress = normalizeTokenAddress(
    params.vault.shareToken?.contractAddress ?? params.vault.address ?? "",
  );
  const depositTokenAddress = normalizeTokenAddress(params.vault.depositToken?.contractAddress ?? "");
  const status = readMarketStatus(params.market.status);
  const investabilityFlags = [
    "withdrawals-underlying-dependent",
    "listing-verified",
    "royco-security-reviewed",
    params.side === "junior" ? "first-loss-junior-tranche" : "senior-protected-by-junior-coverage",
    ...(status ? [`market-status:${status}`] : []),
  ];

  return {
    deploymentPlace: "structured-tranche",
    venueProtocol: "royco-dawn",
    venueChain: params.chain,
    venueRiskTier: "unknown",
    trancheSide: params.side,
    marketCoverageRatio: finiteNumber(params.market.coverage?.currentRatio),
    marketMinCoverageRatio: finiteNumber(params.market.coverage?.requiredRatio),
    marketUtilizationRatio: finiteNumber(params.market.utilization?.currentRatio),
    marketUtilizationLimitRatio: finiteNumber(params.market.utilization?.requiredRatio),
    marketDrawdownRatio: finiteNumber(params.market.drawdown?.ratio),
    marketTotalDrawdowns:
      Number.isInteger(params.market.totalDrawdowns) && params.market.totalDrawdowns != null
        ? params.market.totalDrawdowns
        : null,
    marketStatus: status,
    marketTvlUsd: finiteNumber(params.market.tvlUsd),
    trancheTvlUsd: finiteNumber(params.vault.tvl?.tokenAmountUsd),
    trancheShareTokenAddress: shareTokenAddress || null,
    trancheDepositTokenAddress: depositTokenAddress || null,
    withdrawalDelaySeconds:
      params.side === "junior" && Number.isInteger(params.market.juniorRedemptionDelay)
        ? (params.market.juniorRedemptionDelay ?? null)
        : null,
    kycRequired: null,
    accessRestricted: null,
    investabilityFlags,
  };
}

export function buildTrancheCandidate(params: {
  side: YieldTrancheSide;
  market: RoycoMarket;
  vault: RoycoVault;
  chain: string;
  trackedAsset: TrackedOptionalAsset;
  observedAt: number;
}): ResolvedYieldCandidate | null {
  const marketId = params.market.marketId?.trim();
  if (!marketId) return null;

  const apyRatio = finiteNumber(params.vault.apy);
  if (apyRatio == null || apyRatio <= 0 || apyRatio > ROYCO_DAWN_MAX_APY_RATIO) return null;

  const sourceTvlUsd = finiteNumber(params.vault.tvl?.tokenAmountUsd);
  if (sourceTvlUsd == null || sourceTvlUsd < ROYCO_DAWN_MIN_TRANCHE_TVL_USD) return null;
  const sourceObservedAt = finiteNumber(params.vault.apyInfo?.duration?.end?.blockTimestamp);
  if (
    sourceObservedAt == null ||
    sourceObservedAt > params.observedAt + 60 ||
    params.observedAt - sourceObservedAt > SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000
  ) {
    return null;
  }
  const sourcePool = normalizeTokenAddress(params.vault.address ?? params.vault.shareToken?.contractAddress ?? "");
  const marketName = params.market.name?.trim() || "Royco Dawn market";
  const sourceKey = `royco-dawn:${params.market.chainId}:${marketId}:${params.side}`;
  const sideLabel = params.side === "senior" ? "Senior" : "Junior";

  return {
    stablecoinId: params.trackedAsset.stablecoinId,
    symbol: params.trackedAsset.symbol,
    chain: params.chain,
    address: params.vault.depositToken?.contractAddress ?? null,
    yield: {
      currentApy: apyRatio * 100,
      apyBase: apyRatio * 100,
      apyReward: null,
      sourcePool: sourcePool || marketId,
      sourceTvlUsd,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey,
      yieldSource: `Royco Dawn ${sideLabel}: ${marketName}`,
      yieldType: "structured-tranche",
      project: "royco-dawn",
      chain: params.chain,
      sourceObservedAt: Math.floor(sourceObservedAt),
      comparisonAnchorObservedAt: null,
      sourceRisk: sourceRiskForTranche({
        side: params.side,
        market: params.market,
        vault: params.vault,
        chain: params.chain,
      }),
    },
  };
}
