import { resolveChainId } from "@shared/lib/chains";
import { DS_CHAIN_MAP } from "@shared/lib/chain-provider-registry";
import {
  CIRCUIT_SOURCE,
  DEXSCREENER_MIN_LIQUIDITY_USD,
  USER_AGENT,
} from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../lib/circuit-breaker";
import { fetchDsTokenPoolsWithStatus, getDsTrackedTokenPriceUsd, dsRateLimit } from "../../lib/dexscreener";
import {
  applyResolvedPrice,
  hasMissingPrice,
  type PeggedAsset,
} from "./enrich-prices-shared";
import {
  type EnrichPassResult,
  isUsableFallbackPrice,
  sumCirculatingValue,
  UNIQUE_ACTIVE_SYMBOLS,
} from "./enrich-prices-pass-common";

const DEXSCREENER_MAX_REQUESTS = 10;
const DEXSCREENER_REQUEST_TIMEOUT_MS = 5_000;
const DEXSCREENER_MAX_RETRIES = 0;
const DEXSCREENER_PASS_BUDGET_MS = 45_000;

interface DexScreenerPair {
  baseToken: { symbol: string };
  quoteToken: { symbol: string };
  priceUsd: string;
  liquidity: { usd: number };
  chainId: string;
}

interface DexScreenerTarget {
  chain: string;
  address: string;
}

const ADDRESS_CHAIN_ALIASES: Record<string, string> = {
  avax: "avalanche",
};

function resolveDexTargetChain(rawChain: string): string | null {
  const normalized = rawChain.trim().toLowerCase();
  return resolveChainId(ADDRESS_CHAIN_ALIASES[normalized] ?? normalized);
}

function buildAllowedDexSearchChains(asset: PeggedAsset): Set<string> {
  const allowed = new Set<string>();
  for (const rawChain of asset.chains ?? []) {
    const chain = resolveChainId(rawChain);
    if (!chain || !DS_CHAIN_MAP[chain]) continue;
    allowed.add(DS_CHAIN_MAP[chain]);
  }

  if (asset.address?.includes(":")) {
    const [rawChain] = asset.address.split(":");
    const chain = resolveDexTargetChain(rawChain);
    if (chain && DS_CHAIN_MAP[chain]) {
      allowed.add(DS_CHAIN_MAP[chain]);
    }
  }

  return allowed;
}

function buildDexScreenerTargets(asset: PeggedAsset): DexScreenerTarget[] {
  const rawAddress = asset.address?.trim();
  if (!rawAddress) return [];

  const targets: DexScreenerTarget[] = [];
  const seen = new Set<string>();
  const pushTarget = (chain: string | null, address: string) => {
    if (!chain || !DS_CHAIN_MAP[chain]) return;
    const normalizedAddress = address.trim();
    if (!normalizedAddress) return;
    const key = `${chain}:${normalizedAddress.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ chain, address: normalizedAddress });
  };

  if (rawAddress.includes(":")) {
    const [rawChain, ...rest] = rawAddress.split(":");
    pushTarget(resolveDexTargetChain(rawChain), rest.join(":").trim());
    return targets;
  }

  for (const rawChain of asset.chains ?? []) {
    pushTarget(resolveChainId(rawChain), rawAddress);
  }

  if (targets.length === 0) {
    pushTarget(rawAddress.startsWith("0x") ? "ethereum" : "solana", rawAddress);
  }

  return targets;
}

function medianDexPrice(prices: number[]): number | null {
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function resolveDexScreenerAddressPrice(
  asset: PeggedAsset,
  trackedAddress: string,
  pairs: Awaited<ReturnType<typeof fetchDsTokenPoolsWithStatus>>["pairs"],
  fxRates: Record<string, number> | undefined,
): number | null {
  const prices = pairs
    .map((pair) => {
      const tvl = pair.liquidity?.usd ?? 0;
      if (tvl < DEXSCREENER_MIN_LIQUIDITY_USD) return null;
      return getDsTrackedTokenPriceUsd(pair, trackedAddress).priceUsd;
    })
    .filter((price): price is number => typeof price === "number" && Number.isFinite(price) && price > 0);

  const price = medianDexPrice(prices);
  if (price == null) return null;

  return isUsableFallbackPrice(asset, price, fxRates) ? price : null;
}

function shouldAllowDexScreenerSymbolSearch(asset: PeggedAsset, exactTargets: DexScreenerTarget[]): boolean {
  if (exactTargets.length > 0) {
    return false;
  }
  return UNIQUE_ACTIVE_SYMBOLS.has(asset.symbol.toUpperCase());
}

export async function runDexScreenerPass(
  assets: PeggedAsset[],
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
): Promise<EnrichPassResult> {
  let resolved = 0;

  const stillMissing = assets
    .map((asset, index) => ({ asset, index }))
    .filter((entry) => hasMissingPrice(entry.asset));
  if (stillMissing.length === 0) {
    return { resolved, failures: [] };
  }

  if (stillMissing.length > DEXSCREENER_MAX_REQUESTS) {
    console.warn(`[enrich] ${stillMissing.length} assets still missing prices — capping DexScreener to ${DEXSCREENER_MAX_REQUESTS} requests`);
  }

  const dexscreenerAllowed =
    db != null ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES) : true;
  const dexscreenerSearchAllowed =
    db != null ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.DEXSCREENER_SEARCH) : true;
  let dexExactAttempts = 0;
  let dexExactSuccessfulCalls = 0;
  let dexSearchAttempts = 0;
  let dexSuccessfulSearchCalls = 0;

  if (dexscreenerAllowed || dexscreenerSearchAllowed) {
    const dexCandidates = [...stillMissing]
      .sort((left, right) => {
        const leftExactTargets = buildDexScreenerTargets(left.asset).length;
        const rightExactTargets = buildDexScreenerTargets(right.asset).length;
        if (rightExactTargets !== leftExactTargets) {
          return rightExactTargets - leftExactTargets;
        }

        const leftCirculating = sumCirculatingValue(left.asset);
        const rightCirculating = sumCirculatingValue(right.asset);
        if (rightCirculating !== leftCirculating) {
          return rightCirculating - leftCirculating;
        }

        return left.asset.id.localeCompare(right.asset.id);
      });

    const totalAttempts = () => dexExactAttempts + dexSearchAttempts;
    const dexBudgetDeadlineMs = Date.now() + DEXSCREENER_PASS_BUDGET_MS;
    for (const entry of dexCandidates) {
      if (totalAttempts() >= DEXSCREENER_MAX_REQUESTS) break;

      try {
        const remainingBudgetMs = dexBudgetDeadlineMs - Date.now();
        if (remainingBudgetMs <= 0) {
          console.warn(`[enrich] DexScreener pass budget exhausted after ${totalAttempts()}/${DEXSCREENER_MAX_REQUESTS} requests`);
          break;
        }

        let resolvedFromDex = false;
        const exactTargets = buildDexScreenerTargets(entry.asset);
        for (const target of dexscreenerAllowed ? exactTargets : []) {
          if (totalAttempts() >= DEXSCREENER_MAX_REQUESTS) break;

          const exactRemainingBudgetMs = dexBudgetDeadlineMs - Date.now();
          if (exactRemainingBudgetMs <= 0) break;

          if (totalAttempts() > 0) {
            await dsRateLimit(signal);
          }

          dexExactAttempts += 1;
          const { ok, pairs } = await fetchDsTokenPoolsWithStatus(
            target.chain,
            target.address,
            signal,
            Math.min(DEXSCREENER_REQUEST_TIMEOUT_MS, exactRemainingBudgetMs),
            DEXSCREENER_MAX_RETRIES,
          );
          if (ok) {
            dexExactSuccessfulCalls += 1;
          } else {
            console.warn(`[enrich] DexScreener exact lookup failed for ${entry.asset.symbol} (${target.chain}:${target.address})`);
          }

          const exactPrice = resolveDexScreenerAddressPrice(entry.asset, target.address, pairs, fxRates);
          if (exactPrice == null) continue;

          applyResolvedPrice(assets[entry.index], exactPrice, "dexscreener", "fallback");
          resolved += 1;
          resolvedFromDex = true;
          break;
        }

        if (resolvedFromDex || totalAttempts() >= DEXSCREENER_MAX_REQUESTS) {
          continue;
        }

        const searchRemainingBudgetMs = dexBudgetDeadlineMs - Date.now();
        if (searchRemainingBudgetMs <= 0) {
          console.warn(`[enrich] DexScreener pass budget exhausted after ${totalAttempts()}/${DEXSCREENER_MAX_REQUESTS} requests`);
          break;
        }
        if (!shouldAllowDexScreenerSymbolSearch(entry.asset, exactTargets)) {
          continue;
        }
        if (!dexscreenerSearchAllowed) {
          continue;
        }

        const symbolKey = entry.asset.symbol.toUpperCase();
        const allowedChains = buildAllowedDexSearchChains(entry.asset);

        if (totalAttempts() > 0) {
          await dsRateLimit(signal);
        }

        dexSearchAttempts += 1;
        const res = await fetchWithRetry(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(entry.asset.symbol)}`,
          { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
          DEXSCREENER_MAX_RETRIES,
          { timeoutMs: Math.min(DEXSCREENER_REQUEST_TIMEOUT_MS, searchRemainingBudgetMs) },
        );
        if (!res) {
          console.warn(`[enrich] DexScreener returned no response for ${entry.asset.symbol}`);
          continue;
        }
        if (!res.ok) {
          await cancelResponseBodyQuietly(res);
          console.warn(`[enrich] DexScreener returned ${res.status} for ${entry.asset.symbol}`);
          continue;
        }

        dexSuccessfulSearchCalls += 1;
        const data = (await res.json()) as { pairs?: DexScreenerPair[] };
        if (!data.pairs?.length) continue;

        const candidates = data.pairs.filter((pair) => {
          if (pair.baseToken.symbol.toUpperCase() !== symbolKey) return false;
          if (!pair.priceUsd || !pair.liquidity?.usd) return false;
          if (pair.liquidity.usd < DEXSCREENER_MIN_LIQUIDITY_USD) return false;
          if (allowedChains.size > 0 && !allowedChains.has(String(pair.chainId).toLowerCase())) return false;
          return true;
        });
        if (candidates.length === 0) continue;

        const price = medianDexPrice(
          candidates
            .map((candidate) => Number.parseFloat(candidate.priceUsd))
            .filter((candidatePrice) => Number.isFinite(candidatePrice) && candidatePrice > 0),
        );
        if (price == null) continue;
        if (isUsableFallbackPrice(entry.asset, price, fxRates)) {
          applyResolvedPrice(assets[entry.index], price, "dexscreener", "fallback");
          resolved += 1;
        }
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        console.warn(`[enrich] DexScreener failed for ${entry.asset.symbol}:`, error);
      }
    }

    if (dexExactAttempts > 0 && db) {
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES, dexExactSuccessfulCalls > 0);
    }
    if (dexSearchAttempts > 0 && db) {
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.DEXSCREENER_SEARCH, dexSuccessfulSearchCalls > 0);
    }
    console.log(`[enrich] DexScreener pass: exact=${dexExactSuccessfulCalls}/${dexExactAttempts} search=${dexSuccessfulSearchCalls}/${dexSearchAttempts} resolved=${resolved}`);
  } else {
    console.warn("[enrich] DexScreener exact and search circuits open — skipping pass 4");
  }

  return { resolved, failures: [] };
}
