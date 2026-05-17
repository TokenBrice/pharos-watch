import { DS_CHAIN_MAP, resolveChainId } from "@shared/lib/chains";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  CIRCUIT_SOURCE,
  DEXSCREENER_MIN_LIQUIDITY_USD,
  USER_AGENT,
} from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import {
  applyJsonParseFailureDiagnostic,
  applyNonOkProviderDiagnostic,
  buildPricingProviderDiagnostic,
  isProviderCircuitAllowed,
  recordProviderOutcomeSafe,
} from "../../lib/pricing-provider-lifecycle";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import { fetchDsTokenPoolsWithStatus, getDsTrackedTokenPriceUsd, dsRateLimit } from "../../lib/dexscreener";
import {
  applyResolvedPrice,
  type PeggedAsset,
} from "./enrich-prices-shared";
import {
  collectMissingPriceCandidates,
  type EnrichPassResult,
  isUsableFallbackPrice,
  sumCirculatingValue,
  UNIQUE_ACTIVE_SYMBOLS,
} from "./enrich-prices-pass-common";
import {
  endpointLabel,
  type PricingProviderAttemptDiagnostic,
} from "../../lib/pricing-provider-diagnostics";

const DEXSCREENER_MAX_REQUESTS = 10;
const DEXSCREENER_REQUEST_TIMEOUT_MS = 5_000;
const DEXSCREENER_MAX_RETRIES = 0;
const DEXSCREENER_PASS_BUDGET_MS = 45_000;
const DEXSCREENER_SEARCH_MIN_VOLUME_24H_USD = 10_000;
const DEXSCREENER_SEARCH_MIN_PAIR_AGE_MS = 24 * 60 * 60 * 1000;
const DEXSCREENER_SEARCH_QUOTE_SYMBOLS = new Set([
  "USDC",
  "USDT",
  "USD",
  "DAI",
  "USDS",
  "USDP",
  "PYUSD",
  "FRAX",
  "USDE",
]);

interface DexScreenerPair {
  baseToken: { symbol: string };
  quoteToken: { symbol: string };
  priceUsd: string;
  liquidity: { usd: number };
  volume?: { h24?: number };
  pairCreatedAt?: number | null;
  chainId: string;
}

function isDexScreenerSearchPair(value: unknown): value is DexScreenerPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as Partial<DexScreenerPair>;
  return !!pair.baseToken
    && typeof pair.baseToken.symbol === "string"
    && !!pair.quoteToken
    && typeof pair.quoteToken.symbol === "string"
    && typeof pair.priceUsd === "string"
    && !!pair.liquidity
    && typeof pair.liquidity.usd === "number"
    && typeof pair.chainId === "string";
}

interface DexScreenerTarget {
  chain: string;
  address: string;
  expectedSymbol?: string;
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

  const targets: DexScreenerTarget[] = [];
  const seen = new Set<string>();
  const pushTarget = (chain: string | null, address: string, expectedSymbol?: string) => {
    if (!chain || !DS_CHAIN_MAP[chain]) return;
    const trimmedAddress = address.trim();
    const normalizedAddress = trimmedAddress.startsWith("0x")
      ? trimmedAddress.toLowerCase()
      : trimmedAddress;
    if (!normalizedAddress) return;
    const normalizedExpectedSymbol = expectedSymbol?.trim();
    const key = `${chain}:${normalizedAddress}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({
      chain,
      address: normalizedAddress,
      ...(normalizedExpectedSymbol ? { expectedSymbol: normalizedExpectedSymbol } : {}),
    });
  };

  if (rawAddress?.includes(":")) {
    const [rawChain, ...rest] = rawAddress.split(":");
    pushTarget(resolveDexTargetChain(rawChain), rest.join(":").trim());
    return targets;
  }

  if (rawAddress) {
    for (const rawChain of asset.chains ?? []) {
      pushTarget(resolveChainId(rawChain), rawAddress);
    }

    if (targets.length === 0) {
      pushTarget(rawAddress.startsWith("0x") ? "ethereum" : "solana", rawAddress);
    }
    return targets;
  }

  const meta = ACTIVE_META_BY_ID.get(String(asset.id));
  const deployments = [...(meta?.contracts ?? []), ...(meta?.tradedContracts ?? [])];
  for (const deployment of deployments) {
    const address = deployment.address?.trim();
    if (!address) continue;
    pushTarget(resolveChainId(deployment.chain), address, asset.symbol);
  }

  return targets;
}

function getDexPairTrackedTokenSymbol(pair: Awaited<ReturnType<typeof fetchDsTokenPoolsWithStatus>>["pairs"][number], trackedAddress: string): string | null {
  const tracked = trackedAddress.toLowerCase();
  if (pair.baseToken.address.toLowerCase() === tracked) return pair.baseToken.symbol;
  if (pair.quoteToken.address.toLowerCase() === tracked) return pair.quoteToken.symbol;
  return null;
}

function medianDexPrice(prices: number[]): number | null {
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function resolveDexScreenerAddressPrice(
  asset: PeggedAsset,
  target: DexScreenerTarget,
  pairs: Awaited<ReturnType<typeof fetchDsTokenPoolsWithStatus>>["pairs"],
  fxRates: Record<string, number> | undefined,
): number | null {
  const prices = pairs
    .map((pair) => {
      const tvl = pair.liquidity?.usd ?? 0;
      if (tvl < DEXSCREENER_MIN_LIQUIDITY_USD) return null;
      if (
        target.expectedSymbol &&
        getDexPairTrackedTokenSymbol(pair, target.address)?.toUpperCase() !== target.expectedSymbol.toUpperCase()
      ) {
        return null;
      }
      return getDsTrackedTokenPriceUsd(pair, target.address).priceUsd;
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

function isDexScreenerSearchCandidate(
  pair: DexScreenerPair,
  symbolKey: string,
  allowedChains: Set<string>,
): boolean {
  if (allowedChains.size === 0) return false;
  if (pair.baseToken.symbol.toUpperCase() !== symbolKey) return false;
  if (!DEXSCREENER_SEARCH_QUOTE_SYMBOLS.has(pair.quoteToken.symbol.toUpperCase())) return false;
  if (!pair.priceUsd || !pair.liquidity?.usd) return false;
  if (pair.liquidity.usd < DEXSCREENER_MIN_LIQUIDITY_USD) return false;
  if (!allowedChains.has(String(pair.chainId).toLowerCase())) return false;

  const volume24h = pair.volume?.h24;
  if (typeof volume24h !== "number" || !Number.isFinite(volume24h) || volume24h < DEXSCREENER_SEARCH_MIN_VOLUME_24H_USD) {
    return false;
  }

  if (typeof pair.pairCreatedAt !== "number" || !Number.isFinite(pair.pairCreatedAt)) {
    return false;
  }
  return Date.now() - pair.pairCreatedAt >= DEXSCREENER_SEARCH_MIN_PAIR_AGE_MS;
}

export async function runDexScreenerPass(
  assets: PeggedAsset[],
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
): Promise<EnrichPassResult> {
  let resolved = 0;
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];

  const stillMissing = collectMissingPriceCandidates(assets);
  if (stillMissing.length === 0) {
    return { resolved, failures: [] };
  }

  if (stillMissing.length > DEXSCREENER_MAX_REQUESTS) {
    console.warn(`[enrich] ${stillMissing.length} assets still missing prices — capping DexScreener to ${DEXSCREENER_MAX_REQUESTS} requests`);
  }

  const dexscreenerAllowed = await isProviderCircuitAllowed({
    db,
    circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES,
    diagnostic: {
      source: "dexscreener-exact",
      stage: "fallback",
      endpoint: "api.dexscreener.com/tokens/v1",
      candidateCount: stillMissing.length,
    },
    diagnostics,
    errorMessage: "DexScreener exact circuit open",
  });
  const dexscreenerSearchAllowed = await isProviderCircuitAllowed({
    db,
    circuitSource: CIRCUIT_SOURCE.DEXSCREENER_SEARCH,
    diagnostic: {
      source: "dexscreener-search",
      stage: "fallback",
      endpoint: "api.dexscreener.com/latest/dex/search",
      candidateCount: stillMissing.length,
    },
    diagnostics,
    errorMessage: "DexScreener search circuit open",
  });
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
            diagnostics.push({
              source: "dexscreener-exact",
              stage: "fallback",
              endpoint: endpointLabel(`https://api.dexscreener.com/tokens/v1/${target.chain}/${target.address}`),
              status: null,
              ok: false,
              success: false,
              candidateCount: 1,
              errorClass: "upstream-error",
              errorMessage: "DexScreener exact lookup returned no usable response",
            });
          }

          const exactPrice = resolveDexScreenerAddressPrice(entry.asset, target, pairs, fxRates);
          if (exactPrice == null) continue;

          applyResolvedPrice(assets[entry.index], exactPrice, "dexscreener-exact", "fallback");
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
        if (allowedChains.size === 0) {
          continue;
        }

        if (totalAttempts() > 0) {
          await dsRateLimit(signal);
        }

        dexSearchAttempts += 1;
        const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(entry.asset.symbol)}`;
        const res = await fetchWithRetry(
          searchUrl,
          { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
          DEXSCREENER_MAX_RETRIES,
          { timeoutMs: Math.min(DEXSCREENER_REQUEST_TIMEOUT_MS, searchRemainingBudgetMs) },
        );
        const searchDiagnostic: PricingProviderAttemptDiagnostic = buildPricingProviderDiagnostic({
          source: "dexscreener-search",
          stage: "fallback",
          endpoint: endpointLabel(searchUrl),
          candidateCount: 1,
        }, {
          status: res?.status ?? null,
          ok: res?.ok === true,
        });
        if (!res) {
          diagnostics.push(await applyNonOkProviderDiagnostic(searchDiagnostic, res, {
            noResponseErrorMessage: "DexScreener search returned no response",
          }));
          console.warn(`[enrich] DexScreener returned no response for ${entry.asset.symbol}`);
          continue;
        }
        if (!res.ok) {
          diagnostics.push(await applyNonOkProviderDiagnostic(searchDiagnostic, res));
          console.warn(`[enrich] DexScreener returned ${res.status} for ${entry.asset.symbol}`);
          continue;
        }

        let data: { pairs?: unknown };
        try {
          data = (await res.json()) as { pairs?: unknown };
        } catch (error) {
          await cancelResponseBodyQuietly(res);
          diagnostics.push(applyJsonParseFailureDiagnostic(searchDiagnostic, error));
          console.warn(`[enrich] DexScreener returned malformed JSON for ${entry.asset.symbol}`);
          continue;
        }
        if (data.pairs != null && !Array.isArray(data.pairs)) {
          diagnostics.push({
            ...searchDiagnostic,
            ok: true,
            errorClass: "invalid-shape",
            errorMessage: "Expected DexScreener search pairs to be an array",
          });
          console.warn(`[enrich] DexScreener returned malformed pairs for ${entry.asset.symbol}`);
          continue;
        }
        const pairs = Array.isArray(data.pairs)
          ? data.pairs.filter(isDexScreenerSearchPair)
          : [];
        if (Array.isArray(data.pairs) && data.pairs.length > 0 && pairs.length === 0) {
          diagnostics.push({
            ...searchDiagnostic,
            ok: true,
            responseRowCount: data.pairs.length,
            errorClass: "no-usable-pairs",
            errorMessage: "DexScreener search returned no usable pairs",
          });
          console.warn(`[enrich] DexScreener returned no usable pairs for ${entry.asset.symbol}`);
          continue;
        }

        dexSuccessfulSearchCalls += 1;
        searchDiagnostic.responseRowCount = pairs.length;
        if (pairs.length === 0) continue;

        const candidates = pairs.filter((pair) => {
          return isDexScreenerSearchCandidate(pair, symbolKey, allowedChains);
        });
        if (candidates.length === 0) continue;

        const price = medianDexPrice(
          candidates
            .map((candidate) => Number.parseFloat(candidate.priceUsd))
            .filter((candidatePrice) => Number.isFinite(candidatePrice) && candidatePrice > 0),
        );
        if (price == null) continue;
        if (isUsableFallbackPrice(entry.asset, price, fxRates)) {
          applyResolvedPrice(assets[entry.index], price, "dexscreener-search", "fallback");
          searchDiagnostic.resolvedCount = 1;
          searchDiagnostic.success = true;
          diagnostics.push(searchDiagnostic);
          resolved += 1;
        } else {
          diagnostics.push({
            ...searchDiagnostic,
            matchedCount: candidates.length,
            errorClass: "price-rejected",
            errorMessage: "DexScreener search price failed fallback validation",
          });
        }
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        console.warn(`[enrich] DexScreener failed for ${entry.asset.symbol}:`, error);
      }
    }

    await recordProviderOutcomeSafe({
      db,
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES,
      attempted: dexExactAttempts,
      successful: dexExactSuccessfulCalls,
    });
    await recordProviderOutcomeSafe({
      db,
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_SEARCH,
      attempted: dexSearchAttempts,
      successful: dexSuccessfulSearchCalls,
    });
    console.log(`[enrich] DexScreener pass: exact=${dexExactSuccessfulCalls}/${dexExactAttempts} search=${dexSuccessfulSearchCalls}/${dexSearchAttempts} resolved=${resolved}`);
  } else {
    console.warn("[enrich] DexScreener exact and search circuits open — skipping pass 4");
  }

  return { resolved, failures: [], diagnostics };
}
