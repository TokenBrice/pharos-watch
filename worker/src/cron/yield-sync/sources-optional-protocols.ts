import { DAY_SECONDS } from "@shared/lib/time-constants";
import { type ChainRpcConfig, getChainRpc } from "../../lib/chain-registry";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { USER_AGENT } from "../../lib/constants";
import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { buildOnChainSourceKey } from "../yield-helpers";
import { createOptionalSourceBudget, resolveCanonicalChain } from "./sources-helpers";
import type { ResolvedYield, ResolvedYieldCandidate } from "./types";

const LIQUITY_V1_LUSD_ID = "lusd-liquity";
const BPROTOCOL_LQTY_ONLY_SOURCE_LABEL = "B.Protocol Stability Pool (LQTY only)";
const BPROTOCOL_LQTY_ONLY_SOURCE_TYPE = "lending-vault";
const LIQUITY_STABILITY_POOL_TOTAL_LQTY_REWARD = 32_000_000;
const LIQUITY_DAILY_LQTY_ISSUANCE_FACTOR = 1 - Math.pow(0.5, 1 / 365);
const LIQUITY_COMMUNITY_ISSUANCE = "0xD8c9D9071123a059C6E0A945cF0e0c82b508d816";
const LIQUITY_STABILITY_POOL = "0x66017D22b0f8556afDd19FC67041899Eb65a21bb";
const LIQUITY_TOTAL_LQTY_ISSUED_SELECTOR = "0xb140384b";
const LIQUITY_TOTAL_LUSD_DEPOSITS_SELECTOR = "0x9bf2f1ac";
const LIQUITY_LQTY_GECKO_ID = "liquity";
const BIMA_SUSBD_SOURCE_KEY = "protocol-api:bima-susbd";
const BIMA_SUSBD_SOURCE_LABEL = "BIMA savings (sUSBD)";
const BIMA_SUSBD_SOURCE_TYPE = "lending-vault";
const BIMA_EARN_POOLS_URL =
  "https://bima.money/api/earn/pools?network=Ethereum&user=0x0000000000000000000000000000000000000000";
const BIMA_MIN_TVL_USD = 100_000;
const BIMA_MIN_APY_PERCENT = 0.01;
const HASHNOTE_USYC_SOURCE_KEY = "protocol-api:hashnote-usyc";
const HASHNOTE_USYC_SOURCE_LABEL = "Hashnote USYC";
const HASHNOTE_USYC_SOURCE_TYPE = "nav-appreciation";
const HASHNOTE_PRICE_REPORTS_URL = "https://usyc.hashnote.com/api/price-reports";
const HASHNOTE_TARGET_LOOKBACK_SEC = 7 * DAY_SECONDS;
const HASHNOTE_MIN_LOOKBACK_SEC = 5 * DAY_SECONDS;
const HASHNOTE_MAX_FRESHNESS_SEC = 3 * DAY_SECONDS;
const OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS = 8_000;
const OPTIONAL_PROTOCOL_API_BUDGET_MS = 25_000;
const ONDO_USDY_SOURCE_KEY = "protocol-api:ondo-usdy-oracle";
const ONDO_USDY_SOURCE_LABEL = "Ondo USDY Oracle";
const ONDO_USDY_SOURCE_TYPE = "nav-appreciation";
const ONDO_USDY_ORACLE = "0xa0219aa5b31e65bc920b5b6dfb8edf0988121de0";
const ONDO_GET_PRICE_SELECTOR = "0x98d5fdca";
const MORPHO_GQL_URL = "https://api.morpho.org/graphql";
const MORPHO_STABLECOIN_SYMBOLS = ["USDC", "USDT", "DAI", "USDS", "GHO", "FRAX", "PYUSD", "FRXUSD", "crvUSD", "DOLA", "LUSD"];
const MORPHO_STABLECOIN_QUERY = `query($symbols: [String!]!) {
  vaults(first: 100, where: { listed: true, assetSymbol_in: $symbols, totalAssetsUsd_gte: 100000 }) {
    items {
      address name
      asset { symbol address }
      chain { id }
      state { netApy totalAssetsUsd fee }
    }
  }
}`;
const PENDLE_MARKETS_BASE = "https://api-v2.pendle.finance/core/v1";
const PENDLE_CHAINS = [1, 42161, 8453];
const YEARN_KONG_GQL_URL = "https://kong.yearn.fi/api/gql";
const YEARN_KONG_CHAINS = [1, 10, 137, 8453, 42161];
const YEARN_KONG_VAULTS_QUERY = `query($chainId: Int!) {
  vaults(chainId: $chainId) {
    address name yearn
    asset { symbol address }
    tvl { close }
    apy { net monthlyNet }
    meta { category isRetired }
  }
}`;
const BEEFY_APY_URL = "https://api.beefy.finance/apy";
const BEEFY_VAULTS_URL = "https://api.beefy.finance/vaults";

interface HashnoteReport {
  roundId: string;
  price: string;
  timestamp: string;
}

interface BimaEarnPool {
  id?: string;
  amountTVL?: number;
  unboostedAPR?: number;
  boostedAPR?: number;
  token?: {
    title?: string;
    label?: string;
  };
}

interface MorphoVaultItem {
  address: string; name: string;
  asset: { symbol: string; address?: string | null };
  chain: { id: number };
  state: { netApy: number; totalAssetsUsd: number | null; fee: number } | null;
}

interface PendleMarket {
  id: string; address: string; chainId: number;
  isActive: boolean; expiry: string;
  impliedApy: number; underlyingApy: number; aggregatedApy: number;
  underlyingAsset: { symbol: string; address: string };
  assetRepresentation: string;
  protocol: string;
  liquidity: { usd: number };
  categoryIds: string[];
}

interface KongVault {
  address: string; name: string; yearn: boolean;
  asset: { symbol: string; address?: string | null };
  tvl: { close: number } | null;
  apy: { net: number | null; monthlyNet: number | null } | null;
  meta: { category: string | null; isRetired: boolean | null } | null;
}

interface BeefyVault {
  id: string;
  name: string;
  token: string;
  assets: string[];
  status: string;
  chain: string;
  platformId: string;
  tokenAddress: string;
}

async function fetchEthCallUint256(
  rpcUrl: string,
  chain: string,
  to: string,
  data: string,
  signal?: AbortSignal,
): Promise<bigint | null> {
  try {
    return await fetchEvmUint256AtBlock(chain, to, data, "latest", {
      extraRpcUrls: [rpcUrl],
      signal,
      timeoutMs: 10_000,
    });
  } catch (error) {
    console.warn(`[yield] eth_call failed for ${to} ${data}:`, error);
    return null;
  }
}

async function fetchCoinGeckoUsdPrice(
  geckoId: string,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<number | null> {
  try {
    const res = await fetchWithRetry(
      cgUrl(`/simple/price?ids=${encodeURIComponent(geckoId)}&vs_currencies=usd`, coingeckoApiKey ?? null),
      {
        headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
        signal,
      },
      1,
    );
    if (!res?.ok) return null;

    const body = (await res.json()) as Record<string, { usd?: number }>;
    const price = body[geckoId]?.usd;
    return typeof price === "number" && price > 0 ? price : null;
  } catch (error) {
    console.warn(`[yield] CoinGecko price fetch failed for ${geckoId}:`, error);
    return null;
  }
}

export async function fetchBprotocolLqtyOnlySource(
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  coingeckoApiKey?: string | null,
): Promise<ResolvedYield | null> {
  if (!chainRpcs) {
    console.warn("[yield] No chain RPCs provided for B.Protocol LQTY-only source");
    return null;
  }
  const rpc = getChainRpc(chainRpcs, "ethereum");
  if (!rpc) {
    console.warn("[yield] No Ethereum RPC configured for B.Protocol LQTY-only source");
    return null;
  }

  try {
    const lqtyPriceUsd = await fetchCoinGeckoUsdPrice(LIQUITY_LQTY_GECKO_ID, signal, coingeckoApiKey);
    if (lqtyPriceUsd == null) return null;

    let totalLusdDepositsRaw: bigint | null = null;
    let totalLqtyIssuedRaw: bigint | null = null;
    const rpcUrls = [rpc.rpcUrl, rpc.fallbackRpcUrl].filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    );

    for (const rpcUrl of rpcUrls) {
      const [lusdDeposits, lqtyIssued] = await Promise.all([
        fetchEthCallUint256(rpcUrl, "ethereum", LIQUITY_STABILITY_POOL, LIQUITY_TOTAL_LUSD_DEPOSITS_SELECTOR, signal),
        fetchEthCallUint256(rpcUrl, "ethereum", LIQUITY_COMMUNITY_ISSUANCE, LIQUITY_TOTAL_LQTY_ISSUED_SELECTOR, signal),
      ]);
      if (lusdDeposits != null && lqtyIssued != null) {
        totalLusdDepositsRaw = lusdDeposits;
        totalLqtyIssuedRaw = lqtyIssued;
        break;
      }
    }

    if (totalLusdDepositsRaw == null || totalLqtyIssuedRaw == null) return null;

    const totalLusdDeposits = Number(totalLusdDepositsRaw) / 1e18;
    const totalLqtyIssued = Number(totalLqtyIssuedRaw) / 1e18;
    if (!Number.isFinite(totalLusdDeposits) || totalLusdDeposits <= 0) return null;
    if (!Number.isFinite(totalLqtyIssued) || totalLqtyIssued < 0) return null;

    const remainingLqtyRewards = Math.max(
      0,
      LIQUITY_STABILITY_POOL_TOTAL_LQTY_REWARD - totalLqtyIssued,
    );
    if (remainingLqtyRewards <= 0) return null;

    const apr =
      (remainingLqtyRewards * LIQUITY_DAILY_LQTY_ISSUANCE_FACTOR * lqtyPriceUsd * 365 * 100)
      / totalLusdDeposits;
    if (!Number.isFinite(apr) || apr <= 0) return null;

    return {
      currentApy: apr,
      apyBase: null,
      apyReward: apr,
      sourcePool: null,
      sourceTvlUsd: totalLusdDeposits,
      dataSource: "onchain",
      exchangeRate: null,
      sourceKey: buildOnChainSourceKey(LIQUITY_V1_LUSD_ID),
      yieldSource: BPROTOCOL_LQTY_ONLY_SOURCE_LABEL,
      yieldType: BPROTOCOL_LQTY_ONLY_SOURCE_TYPE,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    console.warn("[yield] B.Protocol LQTY-only source failed:", error);
    return null;
  }
}

export async function fetchBimaSusbdSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  try {
    const res = await fetchWithRetry(
      BIMA_EARN_POOLS_URL,
      {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal,
      },
      0,
      { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
    );
    if (!res?.ok) return null;

    const body = (await res.json()) as { success?: boolean; data?: unknown };
    if (!body.success || !Array.isArray(body.data) || body.data.length === 0) return null;

    const pool = (body.data as BimaEarnPool[]).find((entry) => {
      const title = entry.token?.title?.toUpperCase();
      const label = entry.token?.label?.toUpperCase();
      return title === "USBD" || label === "USBD";
    });
    if (!pool) return null;

    const unboostedApr =
      typeof pool.unboostedAPR === "number" && Number.isFinite(pool.unboostedAPR)
        ? pool.unboostedAPR
        : null;
    const boostedApr =
      typeof pool.boostedAPR === "number" && Number.isFinite(pool.boostedAPR)
        ? pool.boostedAPR
        : null;
    const currentApy =
      unboostedApr != null && boostedApr != null
        ? Math.max(unboostedApr, boostedApr)
        : (unboostedApr ?? boostedApr);
    if (currentApy == null || currentApy < BIMA_MIN_APY_PERCENT) return null;

    const sourceTvlUsd =
      typeof pool.amountTVL === "number" && Number.isFinite(pool.amountTVL) && pool.amountTVL >= BIMA_MIN_TVL_USD
        ? pool.amountTVL
        : null;
    if (sourceTvlUsd == null) return null;

    return {
      currentApy,
      apyBase: unboostedApr ?? currentApy,
      apyReward:
        boostedApr != null && unboostedApr != null
          ? Math.max(0, boostedApr - unboostedApr)
          : null,
      sourcePool: typeof pool.id === "string" ? pool.id : null,
      sourceTvlUsd,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey: BIMA_SUSBD_SOURCE_KEY,
      yieldSource: BIMA_SUSBD_SOURCE_LABEL,
      yieldType: BIMA_SUSBD_SOURCE_TYPE,
      sourceObservedAt: Math.floor(Date.now() / 1000),
      comparisonAnchorObservedAt: null,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    console.warn("[yield] BIMA sUSBD source failed:", error);
    return null;
  }
}

export async function fetchHashnoteUsycSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  try {
    const res = await fetchWithRetry(
      HASHNOTE_PRICE_REPORTS_URL,
      {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal,
      },
      0,
      { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
    );
    if (!res?.ok) return null;

    const body = (await res.json()) as { entity?: string; data?: HashnoteReport[] };
    const reports = body.data;
    if (!Array.isArray(reports) || reports.length < 2) return null;

    const sortedReports = [...reports]
      .map((report) => ({
        ...report,
        parsedTimestamp: parseInt(report.timestamp, 10),
      }))
      .filter((report) => Number.isFinite(report.parsedTimestamp))
      .sort((a, b) => b.parsedTimestamp - a.parsedTimestamp);
    if (sortedReports.length < 2) return null;

    const latest = sortedReports[0];
    const latestPrice = parseFloat(latest.price);
    const latestTimeSec = latest.parsedTimestamp;
    if (!Number.isFinite(latestPrice) || latestPrice <= 0) return null;
    if (!Number.isFinite(latestTimeSec)) return null;
    if (Math.floor(Date.now() / 1000) - latestTimeSec > HASHNOTE_MAX_FRESHNESS_SEC) return null;

    const targetAnchorSec = latestTimeSec - HASHNOTE_TARGET_LOOKBACK_SEC;
    let anchor = sortedReports[sortedReports.length - 1];
    for (const report of sortedReports) {
      if (report.parsedTimestamp <= targetAnchorSec) {
        anchor = report;
        break;
      }
    }
    const anchorPrice = parseFloat(anchor.price);
    const anchorTimeSec = anchor.parsedTimestamp;
    if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) return null;

    const lookbackSec = latestTimeSec - anchorTimeSec;
    if (lookbackSec < HASHNOTE_MIN_LOOKBACK_SEC) return null;
    const daysDelta = lookbackSec / DAY_SECONDS;

    const apy = (Math.pow(latestPrice / anchorPrice, 365.25 / daysDelta) - 1) * 100;
    if (!Number.isFinite(apy) || apy < 0) return null;

    return {
      currentApy: apy, apyBase: apy, apyReward: null,
      sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
      exchangeRate: null, sourceKey: HASHNOTE_USYC_SOURCE_KEY,
      yieldSource: HASHNOTE_USYC_SOURCE_LABEL, yieldType: HASHNOTE_USYC_SOURCE_TYPE,
      sourceObservedAt: latestTimeSec,
      comparisonAnchorObservedAt: anchorTimeSec,
    };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[yield] Hashnote USYC source failed:", error);
    return null;
  }
}

export async function fetchOndoUsdyOracleSource(
  prevPriceBigint: bigint | null,
  daysDelta: number,
  comparisonAnchorObservedAt: number | null,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<ResolvedYield | null> {
  try {
    const rpc = chainRpcs ? getChainRpc(chainRpcs, "ethereum") : undefined;
    const extraRpcUrls = rpc?.fallbackRpcUrl ? [rpc.fallbackRpcUrl] : [];
    const currentPrice = await fetchEvmUint256AtBlock(
      "ethereum", ONDO_USDY_ORACLE, ONDO_GET_PRICE_SELECTOR, "latest",
      { extraRpcUrls, signal },
    );
    if (!currentPrice || currentPrice === 0n) return null;

    const currentPriceFloat = Number(currentPrice) / 1e18;
    if (!Number.isFinite(currentPriceFloat) || currentPriceFloat <= 0) return null;

    if (!prevPriceBigint || prevPriceBigint === 0n || daysDelta < 1) {
      return {
        currentApy: 0, apyBase: null, apyReward: null,
        sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
        exchangeRate: currentPriceFloat, sourceKey: ONDO_USDY_SOURCE_KEY,
        yieldSource: ONDO_USDY_SOURCE_LABEL, yieldType: ONDO_USDY_SOURCE_TYPE,
        sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt: null,
      };
    }

    const prevPriceFloat = Number(prevPriceBigint) / 1e18;
    const apy = (Math.pow(currentPriceFloat / prevPriceFloat, 365.25 / daysDelta) - 1) * 100;
    if (!Number.isFinite(apy) || apy < 0) return null;

    return {
      currentApy: apy, apyBase: apy, apyReward: null,
      sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
      exchangeRate: currentPriceFloat, sourceKey: ONDO_USDY_SOURCE_KEY,
      yieldSource: ONDO_USDY_SOURCE_LABEL, yieldType: ONDO_USDY_SOURCE_TYPE,
      sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt,
    };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[yield] Ondo USDY oracle source failed:", error);
    return null;
  }
}

export async function fetchMorphoVaultSources(
  signal?: AbortSignal,
): Promise<ResolvedYieldCandidate[]> {
  const budget = createOptionalSourceBudget("Morpho vault sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  try {
    const res = await fetchWithRetry(MORPHO_GQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ query: MORPHO_STABLECOIN_QUERY, variables: { symbols: MORPHO_STABLECOIN_SYMBOLS } }),
      signal: budget.signal,
    }, 0, { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS });
    if (!res?.ok) return [];

    const body = (await res.json()) as { data?: { vaults?: { items?: MorphoVaultItem[] } } };
    const items = body.data?.vaults?.items;
    if (!Array.isArray(items)) return [];

    const results: ResolvedYieldCandidate[] = [];
    for (const vault of items) {
      const apy = vault.state?.netApy;
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;

      const tvl = vault.state?.totalAssetsUsd;
      if (typeof tvl !== "number" || tvl < 100_000) continue;
      const chain = resolveCanonicalChain(vault.chain?.id);
      if (!chain) continue;

      results.push({
        symbol: vault.asset.symbol,
        chain,
        address: vault.asset.address ?? null,
        yield: {
          currentApy: apy * 100,
          apyBase: apy * 100,
          apyReward: null,
          sourcePool: vault.address,
          sourceTvlUsd: tvl,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: `protocol-api:morpho-vault:${chain}:${vault.address.toLowerCase()}`,
          yieldSource: `Morpho: ${vault.name}`,
          yieldType: "lending-opportunity",
          sourceObservedAt: Math.floor(Date.now() / 1000),
          comparisonAnchorObservedAt: null,
        },
      });
    }
    return results;
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (budget.budgetController.signal.aborted) {
      console.warn("[yield] Morpho vault sources budget exhausted; continuing without this source family");
      return [];
    }
    console.warn("[yield] Morpho vault sources failed:", error);
    return [];
  } finally {
    budget.cleanup();
  }
}

export async function fetchPendleMarketSources(
  signal?: AbortSignal,
): Promise<ResolvedYieldCandidate[]> {
  const results: ResolvedYieldCandidate[] = [];
  const budget = createOptionalSourceBudget("Pendle market sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);

  try {
    for (const chainId of PENDLE_CHAINS) {
      if (budget.budgetController.signal.aborted) break;
      try {
        let skip = 0;
        const limit = 100;
        while (!budget.budgetController.signal.aborted) {
          const url = `${PENDLE_MARKETS_BASE}/${chainId}/markets?limit=${limit}&skip=${skip}&is_active=true`;
          const res = await fetchWithRetry(url, {
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
            signal: budget.signal,
          }, 0, { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS });
          if (!res?.ok) break;

          const body = (await res.json()) as { total?: number; results?: PendleMarket[] };
          if (!Array.isArray(body.results) || body.results.length === 0) break;

          for (const market of body.results) {
            if (!market.categoryIds?.includes("stables")) continue;
            if (!market.isActive) continue;

            const apy = market.impliedApy;
            if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;

            const tvl = market.liquidity?.usd;
            if (typeof tvl !== "number" || tvl < 100_000) continue;

            const chain = resolveCanonicalChain(market.chainId);
            if (!chain) continue;

            results.push({
              symbol: market.underlyingAsset.symbol,
              chain,
              address: market.underlyingAsset.address,
              yield: {
                currentApy: apy * 100,
                apyBase: apy * 100,
                apyReward: null,
                sourcePool: market.address,
                sourceTvlUsd: tvl,
                dataSource: "protocol-api",
                exchangeRate: null,
                sourceKey: `protocol-api:pendle:${chain}:${market.address.toLowerCase()}`,
                yieldSource: `Pendle: ${market.protocol} ${market.assetRepresentation}`,
                yieldType: "lending-opportunity",
                sourceObservedAt: Math.floor(Date.now() / 1000),
                comparisonAnchorObservedAt: null,
              },
            });
          }

          skip += body.results.length;
          if (body.results.length < limit || (typeof body.total === "number" && skip >= body.total)) {
            break;
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        if (budget.budgetController.signal.aborted) {
          console.warn(`[yield] Pendle sources budget exhausted; keeping ${results.length} partial results`);
          break;
        }
        console.warn(`[yield] Pendle chain ${chainId} failed:`, error);
      }
    }
    return results;
  } finally {
    budget.cleanup();
  }
}

export async function fetchYearnKongSources(
  signal?: AbortSignal,
): Promise<ResolvedYieldCandidate[]> {
  const results: ResolvedYieldCandidate[] = [];
  const seenAddresses = new Set<string>();
  const budget = createOptionalSourceBudget("Yearn Kong sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);

  try {
    for (const chainId of YEARN_KONG_CHAINS) {
      if (budget.budgetController.signal.aborted) break;
      try {
        const res = await fetchWithRetry(YEARN_KONG_GQL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
          body: JSON.stringify({ query: YEARN_KONG_VAULTS_QUERY, variables: { chainId } }),
          signal: budget.signal,
        }, 0, { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS });
        if (!res?.ok) continue;

        const body = (await res.json()) as { data?: { vaults?: KongVault[] } };
        const vaults = body.data?.vaults;
        if (!Array.isArray(vaults)) continue;

        for (const vault of vaults) {
          if (seenAddresses.has(vault.address.toLowerCase())) continue;
          if (vault.meta?.isRetired) continue;
          if (vault.meta?.category !== "Stablecoin") continue;

          const netApy = vault.apy?.monthlyNet ?? vault.apy?.net;
          if (typeof netApy !== "number" || !Number.isFinite(netApy) || netApy <= 0) continue;

          const tvl = vault.tvl?.close;
          if (typeof tvl !== "number" || tvl < 100_000) continue;

          seenAddresses.add(vault.address.toLowerCase());
          const sourcePrefix = vault.yearn ? "Yearn" : "Kong";
          const sourceNamespace = vault.yearn ? "yearn" : "kong";
          const chain = resolveCanonicalChain(chainId);
          if (!chain) continue;
          results.push({
            symbol: vault.asset.symbol,
            chain,
            address: vault.asset.address ?? null,
            yield: {
              currentApy: netApy * 100,
              apyBase: netApy * 100,
              apyReward: null,
              sourcePool: vault.address,
              sourceTvlUsd: tvl,
              dataSource: "protocol-api",
              exchangeRate: null,
              sourceKey: `protocol-api:${sourceNamespace}:${chain}:${vault.address.toLowerCase()}`,
              yieldSource: `${sourcePrefix}: ${vault.name}`,
              yieldType: "lending-opportunity",
              sourceObservedAt: Math.floor(Date.now() / 1000),
              comparisonAnchorObservedAt: null,
            },
          });
        }
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        if (budget.budgetController.signal.aborted) {
          console.warn(`[yield] Yearn Kong sources budget exhausted; keeping ${results.length} partial results`);
          break;
        }
        console.warn(`[yield] Yearn Kong chain ${chainId} failed:`, error);
      }
    }
    return results;
  } finally {
    budget.cleanup();
  }
}

export async function fetchBeefySources(
  signal?: AbortSignal,
): Promise<ResolvedYieldCandidate[]> {
  const budget = createOptionalSourceBudget("Beefy sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  try {
    const [apyRes, vaultsRes] = await Promise.all([
      fetchWithRetry(
        BEEFY_APY_URL,
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
      fetchWithRetry(
        BEEFY_VAULTS_URL,
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
    ]);
    if (!apyRes?.ok || !vaultsRes?.ok) return [];

    const apyMap = (await apyRes.json()) as Record<string, number | null>;
    const vaults = (await vaultsRes.json()) as BeefyVault[];
    if (!Array.isArray(vaults)) return [];

    const results: ResolvedYieldCandidate[] = [];
    for (const vault of vaults) {
      if (vault.status !== "active") continue;
      if (!vault.assets || vault.assets.length !== 1) continue;
      const chain = resolveCanonicalChain(vault.chain);
      if (!chain) continue;
      if (!vault.tokenAddress) continue;

      const apy = apyMap[vault.id];
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0 || apy > 0.5) continue;

      results.push({
        symbol: vault.assets[0],
        chain,
        address: vault.tokenAddress,
        yield: {
          currentApy: apy * 100,
          apyBase: apy * 100,
          apyReward: null,
          sourcePool: vault.id,
          sourceTvlUsd: null,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: `protocol-api:beefy:${chain}:${vault.id}`,
          yieldSource: `Beefy: ${vault.name || vault.id}`,
          yieldType: "lending-opportunity",
          sourceObservedAt: Math.floor(Date.now() / 1000),
          comparisonAnchorObservedAt: null,
        },
      });
    }
    return results;
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (budget.budgetController.signal.aborted) {
      console.warn("[yield] Beefy sources budget exhausted; continuing without this source family");
      return [];
    }
    console.warn("[yield] Beefy sources failed:", error);
    return [];
  } finally {
    budget.cleanup();
  }
}
