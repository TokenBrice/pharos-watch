import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import type { StablecoinMeta } from "@shared/types/core";
import type { YieldMarketStatus, YieldSourceRisk, YieldTrancheSide } from "@shared/types/yield";
import { throwIfAborted } from "../../lib/abort";
import { USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { logWorkerEvent } from "../../lib/structured-log";
import { buildChainAddressKey, normalizeTokenAddress } from "../dex-liquidity/token-resolution";
import { YIELD_VARIANT_MAP } from "../yield-config-variants";
import { OPTIONAL_PROTOCOL_API_BUDGET_MS, OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS } from "./optional-source-runtime";
import { createOptionalSourceBudget, resolveCanonicalChain } from "./sources-helpers";
import type { ResolvedYieldCandidate } from "./types";

const ROYCO_DAWN_EXPLORE_URL = "https://dawn.royco.org/api/v1/market/explore";
const ROYCO_DAWN_PAGE_SIZE = 100;
const ROYCO_DAWN_MIN_MARKET_TVL_USD = 100_000;
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
  tvl?: {
    tokenAmountUsd?: number | null;
  } | null;
  depositToken?: RoycoToken | null;
  shareToken?: RoycoToken | null;
}

interface RoycoMarket {
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

interface RoycoExploreResponse {
  data?: RoycoMarket[];
  count?: number;
}

interface RoycoTrackedAsset {
  stablecoinId: string;
  symbol: string;
}

function stablecoinContracts(meta: Pick<StablecoinMeta, "contracts" | "tradedContracts">) {
  return [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
}

function buildTrackedAssetByChainAddress(): Map<string, RoycoTrackedAsset> {
  const byChainAddress = new Map<string, RoycoTrackedAsset>();

  for (const meta of ACTIVE_STABLECOINS) {
    for (const contract of stablecoinContracts(meta)) {
      const chain = resolveCanonicalChain(contract.chain);
      const address = contract.address.trim();
      if (!chain || !address) continue;
      byChainAddress.set(buildChainAddressKey(chain, address), {
        stablecoinId: meta.id,
        symbol: meta.symbol,
      });
    }
  }

  for (const [stablecoinId, variant] of Object.entries(YIELD_VARIANT_MAP)) {
    if (!variant.variantAddress || !variant.variantChain) continue;
    const chain = resolveCanonicalChain(variant.variantChain);
    const address = variant.variantAddress.trim();
    const meta = ACTIVE_STABLECOINS.find((entry) => entry.id === stablecoinId);
    if (!chain || !address || !meta) continue;
    byChainAddress.set(buildChainAddressKey(chain, address), {
      stablecoinId: meta.id,
      symbol: meta.symbol,
    });
  }

  return byChainAddress;
}

function resolveVaultDepositToken(
  vault: RoycoVault,
  chain: string,
  lookup: Map<string, RoycoTrackedAsset>,
): RoycoTrackedAsset | null {
  const address = vault.depositToken?.contractAddress?.trim() ?? "";
  return address ? (lookup.get(buildChainAddressKey(chain, address)) ?? null) : null;
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

function buildTrancheCandidate(params: {
  side: YieldTrancheSide;
  market: RoycoMarket;
  vault: RoycoVault;
  chain: string;
  trackedAsset: RoycoTrackedAsset;
  observedAt: number;
}): ResolvedYieldCandidate | null {
  const marketId = params.market.marketId?.trim();
  if (!marketId) return null;

  const apyRatio = finiteNumber(params.vault.apy);
  if (apyRatio == null || apyRatio <= 0 || apyRatio > ROYCO_DAWN_MAX_APY_RATIO) return null;

  const sourceTvlUsd = finiteNumber(params.vault.tvl?.tokenAmountUsd);
  if (sourceTvlUsd == null || sourceTvlUsd < ROYCO_DAWN_MIN_TRANCHE_TVL_USD) return null;
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
      sourceObservedAt: params.observedAt,
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

function buildExploreBody(pageIndex: number): string {
  return JSON.stringify({
    page: {
      index: pageIndex,
      size: ROYCO_DAWN_PAGE_SIZE,
    },
    filters: [
      {
        id: "listingType",
        value: "verified",
      },
    ],
    sorting: [
      {
        id: "tvlUsd",
        desc: true,
      },
    ],
  });
}

export async function fetchRoycoDawnSources(signal?: AbortSignal): Promise<ResolvedYieldCandidate[]> {
  const budget = createOptionalSourceBudget("Royco Dawn sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  const trackedByAddress = buildTrackedAssetByChainAddress();
  const observedAt = Math.floor(Date.now() / 1000);
  const results: ResolvedYieldCandidate[] = [];

  try {
    let pageIndex = 0;
    while (!budget.budgetController.signal.aborted) {
      throwIfAborted(budget.budgetController.signal);
      const result = await fetchJsonWithRetry<RoycoExploreResponse>(
        ROYCO_DAWN_EXPLORE_URL,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: buildExploreBody(pageIndex),
          signal: budget.signal,
        },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      );
      if (!result?.response.ok) return results;

      const body = result.body;
      const markets = Array.isArray(body.data) ? body.data : [];
      if (markets.length === 0) break;

      for (const market of markets) {
        const chain = resolveCanonicalChain(market.chainId);
        if (!chain) continue;
        const marketTvlUsd = finiteNumber(market.tvlUsd);
        if (marketTvlUsd == null || marketTvlUsd < ROYCO_DAWN_MIN_MARKET_TVL_USD) continue;
        if (market.listingType !== "verified") continue;

        const seniorVault = market.seniorVault ?? null;
        if (seniorVault) {
          const trackedAsset = resolveVaultDepositToken(seniorVault, chain, trackedByAddress);
          if (trackedAsset) {
            const candidate = buildTrancheCandidate({
              side: "senior",
              market,
              vault: seniorVault,
              chain,
              trackedAsset,
              observedAt,
            });
            if (candidate) results.push(candidate);
          }
        }

        const juniorVault = market.juniorVault ?? null;
        if (juniorVault) {
          const trackedAsset = resolveVaultDepositToken(juniorVault, chain, trackedByAddress);
          if (trackedAsset) {
            const candidate = buildTrancheCandidate({
              side: "junior",
              market,
              vault: juniorVault,
              chain,
              trackedAsset,
              observedAt,
            });
            if (candidate) results.push(candidate);
          }
        }
      }

      pageIndex += 1;
      if (
        markets.length < ROYCO_DAWN_PAGE_SIZE ||
        (typeof body.count === "number" && pageIndex * ROYCO_DAWN_PAGE_SIZE >= body.count)
      ) {
        break;
      }
    }

    return results;
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (!budget.budgetController.signal.aborted) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "royco_dawn_sources_failed",
        job: "sync-yield-supplemental",
        provider: "royco-dawn",
        source: "yield-supplemental",
        message: "Royco Dawn supplemental yield sources failed",
        error,
      });
    }
    return results;
  } finally {
    budget.cleanup();
  }
}
