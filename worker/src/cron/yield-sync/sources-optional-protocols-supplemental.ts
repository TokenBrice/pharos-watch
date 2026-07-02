import { CHAIN_META } from "@shared/lib/chains";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { throwIfAborted } from "../../lib/abort";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT } from "../../lib/constants";
import { buildChainAddressKey, normalizeTokenAddress } from "../dex-liquidity/token-resolution";
import { createOptionalSourceBudget, resolveCanonicalChain } from "./sources-helpers";
import { OPTIONAL_PROTOCOL_API_BUDGET_MS, OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS } from "./optional-source-runtime";
import type { ResolvedYieldCandidate } from "./types";

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

type BeefyTvlPayload = Record<string, number | null | Record<string, number | null>>;

const BEEFY_CHAIN_ALIASES: Record<string, string> = {
  avax: "avalanche",
  one: "harmony",
  zkevm: "polygon-zkevm",
};

interface TrackedMorphoAsset {
  stablecoinId: string;
  symbol: string;
}

interface TrackedMorphoFilters {
  symbols: string[];
  assetsByChainAddress: Map<string, TrackedMorphoAsset>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function resolveBeefyCanonicalChain(chain: string | null | undefined): string | null {
  if (!isNonEmptyString(chain)) return null;
  const alias = BEEFY_CHAIN_ALIASES[chain.toLowerCase()];
  return resolveCanonicalChain(alias ?? chain);
}

function resolveBeefyTvl(tvlMap: BeefyTvlPayload, chain: string, vaultId: string): number | null {
  const evmChainId = CHAIN_META[chain]?.evmChainId;
  if (evmChainId != null) {
    const chainTvlMap = tvlMap[String(evmChainId)];
    if (chainTvlMap && typeof chainTvlMap === "object" && !Array.isArray(chainTvlMap)) {
      return chainTvlMap[vaultId] ?? null;
    }
  }

  const flatTvl = tvlMap[vaultId];
  return typeof flatTvl === "number" ? flatTvl : null;
}

const MORPHO_PAGE_SIZE = 100;
const MORPHO_MIN_TVL_USD = 100_000;
const PENDLE_MIN_EXPIRY_DAYS = 3;
const PENDLE_MAX_EXPIRY_YEARS = 5;
const PENDLE_MAX_IMPLIED_APY = 1;
const PENDLE_MIN_TVL_USD = 100_000;
const KONG_MIN_TVL_USD = 100_000;
const BEEFY_MAX_APY = 0.5;
const BEEFY_MIN_TVL_USD = 100_000;

function buildMorphoFilters(): TrackedMorphoFilters {
  const symbols = new Set<string>();
  const assetsByChainAddress = new Map<string, TrackedMorphoAsset>();

  for (const meta of ACTIVE_STABLECOINS) {
    if (meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER") continue;
    symbols.add(meta.symbol);

    for (const contract of [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])]) {
      const chain = resolveCanonicalChain(contract.chain);
      const address = normalizeTokenAddress(contract.address ?? "");
      if (!chain || !address) continue;
      assetsByChainAddress.set(buildChainAddressKey(chain, address), {
        stablecoinId: meta.id,
        symbol: meta.symbol,
      });
    }
  }

  return {
    symbols: [...symbols].sort((a, b) => a.localeCompare(b)),
    assetsByChainAddress,
  };
}

function resolveMorphoTrackedAsset(
  filters: TrackedMorphoFilters,
  chain: string,
  asset: MorphoVaultItem["asset"],
): TrackedMorphoAsset | null {
  const normalizedAddress = normalizeTokenAddress(asset.address ?? "");
  if (normalizedAddress) {
    const byAddress = filters.assetsByChainAddress.get(buildChainAddressKey(chain, normalizedAddress));
    if (byAddress) return byAddress;
  }

  return null;
}

function isSanePendleExpiry(expiry: string, nowMs: number): boolean {
  const expiryMs = Date.parse(expiry);
  if (!Number.isFinite(expiryMs)) return false;

  const minExpiryMs = nowMs + PENDLE_MIN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const maxExpiryMs = nowMs + PENDLE_MAX_EXPIRY_YEARS * 365.25 * 24 * 60 * 60 * 1000;
  return expiryMs >= minExpiryMs && expiryMs <= maxExpiryMs;
}

export async function fetchMorphoVaultSources(
  signal?: AbortSignal,
): Promise<ResolvedYieldCandidate[]> {
  const budget = createOptionalSourceBudget("Morpho vault sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  const filters = buildMorphoFilters();
  if (filters.symbols.length === 0) return [];

  try {
    const results: ResolvedYieldCandidate[] = [];
    let skip = 0;
    while (!budget.budgetController.signal.aborted) {
      throwIfAborted(budget.budgetController.signal);
      const result = await fetchJsonWithRetry<{ data?: { vaults?: { items?: MorphoVaultItem[] } } }>(
        "https://api.morpho.org/graphql",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
          body: JSON.stringify({
            query: `query($symbols: [String!]!, $first: Int!, $skip: Int!, $minTvl: Float!) {
  vaults(first: $first, skip: $skip, where: { listed: true, assetSymbol_in: $symbols, totalAssetsUsd_gte: $minTvl }) {
    items {
      address name
      asset { symbol address }
      chain { id }
      state { netApy totalAssetsUsd fee }
    }
  }
}`,
            variables: { symbols: filters.symbols, first: MORPHO_PAGE_SIZE, skip, minTvl: MORPHO_MIN_TVL_USD },
          }),
          signal: budget.signal,
        },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      );
      if (!result?.response.ok) return results;

      const body = result.body;
      const items = body.data?.vaults?.items;
      if (!Array.isArray(items) || items.length === 0) break;

      for (const vault of items) {
        const apy = vault.state?.netApy;
        if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;

        const tvl = vault.state?.totalAssetsUsd;
        if (typeof tvl !== "number" || tvl < MORPHO_MIN_TVL_USD) continue;
        if (!isNonEmptyString(vault.address) || !isNonEmptyString(vault.asset?.symbol)) continue;
        const chain = resolveCanonicalChain(vault.chain?.id);
        if (!chain) continue;
        const trackedAsset = resolveMorphoTrackedAsset(filters, chain, vault.asset);
        if (!trackedAsset) continue;

        results.push({
          stablecoinId: trackedAsset.stablecoinId,
          symbol: trackedAsset.symbol,
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
      skip += items.length;
      if (items.length < MORPHO_PAGE_SIZE) break;
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
  const nowMs = Date.now();

  try {
    for (const chainId of [1, 42161, 8453]) {
      if (budget.budgetController.signal.aborted) break;
      try {
        let skip = 0;
        const limit = 100;
        while (!budget.budgetController.signal.aborted) {
          throwIfAborted(budget.budgetController.signal);
          const url = `https://api-v2.pendle.finance/core/v1/${chainId}/markets?limit=${limit}&skip=${skip}&is_active=true`;
          const result = await fetchJsonWithRetry<{ total?: number; results?: PendleMarket[] }>(url, {
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
            signal: budget.signal,
          }, 0, { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS });
          if (!result?.response.ok) break;

          const body = result.body;
          if (!Array.isArray(body.results) || body.results.length === 0) break;

          for (const market of body.results) {
            if (!market.categoryIds?.includes("stables")) continue;
            if (!market.isActive) continue;
            if (!isSanePendleExpiry(market.expiry, nowMs)) continue;

            const apy = market.impliedApy;
            if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0 || apy > PENDLE_MAX_IMPLIED_APY) {
              continue;
            }

            const tvl = market.liquidity?.usd;
            if (typeof tvl !== "number" || tvl < PENDLE_MIN_TVL_USD) continue;
            if (
              !isNonEmptyString(market.address) ||
              !isNonEmptyString(market.underlyingAsset?.symbol) ||
              !isNonEmptyString(market.underlyingAsset?.address)
            ) {
              continue;
            }
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
                yieldSource: `Pendle fixed yield: ${market.protocol} ${market.assetRepresentation}`,
                yieldType: "fixed-yield",
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
    for (const chainId of [1, 10, 137, 8453, 42161]) {
      if (budget.budgetController.signal.aborted) break;
      try {
        const result = await fetchJsonWithRetry<{ data?: { vaults?: KongVault[] } }>(
          "https://kong.yearn.fi/api/gql",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
            body: JSON.stringify({
              query: `query($chainId: Int!) {
  vaults(chainId: $chainId) {
    address name yearn
    asset { symbol address }
    tvl { close }
    apy { net monthlyNet }
    meta { category isRetired }
  }
}`,
              variables: { chainId },
            }),
            signal: budget.signal,
          },
          0,
          { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
        );
        if (!result?.response.ok) continue;

        const body = result.body;
        const vaults = body.data?.vaults;
        if (!Array.isArray(vaults)) continue;

        for (const vault of vaults) {
          if (
            !isNonEmptyString(vault.address) ||
            !isNonEmptyString(vault.name) ||
            !isNonEmptyString(vault.asset?.symbol)
          ) {
            continue;
          }
          if (seenAddresses.has(vault.address.toLowerCase())) continue;
          if (vault.meta?.isRetired) continue;
          if (vault.meta?.category !== "Stablecoin") continue;

          const netApy = vault.apy?.net;
          if (typeof netApy !== "number" || !Number.isFinite(netApy) || netApy <= 0) continue;

          const tvl = vault.tvl?.close;
          if (typeof tvl !== "number" || tvl < KONG_MIN_TVL_USD) continue;

          seenAddresses.add(vault.address.toLowerCase());
          const chain = resolveCanonicalChain(chainId);
          if (!chain) continue;
          const normalizedAssetAddress = vault.asset.address?.toLowerCase() ?? null;
          const isK3Sbold =
            chain === "ethereum" &&
            normalizedAssetAddress === "0x9f4330700a36b29952869fac9b33f45eedd8a3d8" &&
            vault.name.trim().toLowerCase() === "staked ybold";
          const sourcePrefix = vault.yearn ? "Yearn" : "Kong";
          const sourceNamespace = isK3Sbold ? "k3" : (vault.yearn ? "yearn" : "kong");

          results.push({
            stablecoinId: isK3Sbold ? "sbold-k3-capital" : undefined,
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
              yieldSource: isK3Sbold ? "K3: sBOLD" : `${sourcePrefix}: ${vault.name}`,
              yieldType: isK3Sbold ? "lending-vault" : "lending-opportunity",
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
    const [apyRes, vaultsRes, tvlRes] = await Promise.all([
      fetchJsonWithRetry<Record<string, number | null>>(
        "https://api.beefy.finance/apy",
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
      fetchJsonWithRetry<BeefyVault[]>(
        "https://api.beefy.finance/vaults",
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
      fetchJsonWithRetry<BeefyTvlPayload>(
        "https://api.beefy.finance/tvl",
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
    ]);
    if (!apyRes?.response.ok || !vaultsRes?.response.ok || !tvlRes?.response.ok) return [];

    const apyMap = apyRes.body;
    const vaults = vaultsRes.body;
    const tvlMap = tvlRes.body;
    if (!Array.isArray(vaults)) return [];

    const results: ResolvedYieldCandidate[] = [];
    for (const vault of vaults) {
      if (!vault || !isNonEmptyString(vault.id)) continue;
      if (vault.status !== "active") continue;
      if (!vault.assets || vault.assets.length !== 1 || !isNonEmptyString(vault.assets[0])) continue;
      const chain = resolveBeefyCanonicalChain(vault.chain);
      if (!chain) continue;
      if (!isNonEmptyString(vault.tokenAddress)) continue;

      const apy = apyMap[vault.id];
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0 || apy > BEEFY_MAX_APY) continue;
      const tvl = resolveBeefyTvl(tvlMap, chain, vault.id);
      if (typeof tvl !== "number" || !Number.isFinite(tvl) || tvl < BEEFY_MIN_TVL_USD) continue;

      results.push({
        symbol: vault.assets[0],
        chain,
        address: vault.tokenAddress,
        yield: {
          currentApy: apy * 100,
          apyBase: apy * 100,
          apyReward: null,
          sourcePool: vault.id,
          sourceTvlUsd: tvl,
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
