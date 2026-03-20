/**
 * Extracted enrichment passes from enrichMissingPrices.
 *
 * Each pass mutates the shared `assets` array in-place and returns an
 * {@link EnrichPassResult} with the count of resolved prices plus any
 * failure labels. Passes execute sequentially because each reads the
 * mutated `hasMissingPrice` state left by the previous pass.
 */
import { DEFILLAMA_COINS, USER_AGENT, DEXSCREENER_MIN_LIQUIDITY_USD, CIRCUIT_SOURCE } from "../lib/constants";
import { fetchWithRetry } from "../lib/fetch-retry";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { getCache, setCache } from "../lib/db-cache";
import { sleepWithSignal, throwIfAborted } from "../lib/abort";
import { DLPriceResponseSchema } from "../lib/schemas";
import { fetchDsTokenPoolsWithStatus, getDsTrackedTokenPriceUsd } from "../lib/dexscreener";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
} from "../lib/price-validation";
import {
  hasMissingPrice,
  applyResolvedPrice,
  type PeggedAsset,
} from "./enrich-prices";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import { resolveChainId } from "@shared/lib/chains";
import { DS_CHAIN_MAP } from "@shared/lib/chain-provider-registry";

// ── Shared constants ────────────────────────────────────────────────

const CMC_REQUEST_TIMEOUT_MS = 10_000;
const CMC_MAX_RETRIES = 0;
const DEXSCREENER_MAX_REQUESTS = 10;
const DEXSCREENER_REQUEST_TIMEOUT_MS = 5_000;
const DEXSCREENER_MAX_RETRIES = 0;
const DEXSCREENER_PASS_BUDGET_MS = 45_000;
const JUPITER_PRICE_API = "https://lite-api.jup.ag/price/v3";
const JUPITER_MAX_IDS_PER_REQUEST = 50;
const JUPITER_REQUEST_TIMEOUT_MS = 5_000;
const JUPITER_MAX_RETRIES = 0;
const JUPITER_MIN_LIQUIDITY_USD = 50_000;

/** Map DL stablecoins API chain names → DL coins API prefixes */
const CHAIN_PREFIX_MAP: Record<string, string> = {
  "Ethereum": "ethereum",
  "Arbitrum": "arbitrum",
  "Polygon": "polygon",
  "BSC": "bsc",
  "Base": "base",
  "Optimism": "optimism",
  "Avalanche": "avax",
};

// ── Result type ─────────────────────────────────────────────────────

export interface EnrichPassResult {
  resolved: number;
  failures: string[];
}

/** Extended result for the DL contract passes, with per-sub-pass breakdown. */
export interface DlContractPassResult extends EnrichPassResult {
  pass1: number;
  pass1b: number;
}

// ── Internal helpers ────────────────────────────────────────────────

/** Build the DL coins API identifier from an asset address */
function addressToCoinId(address: string): string {
  if (address.includes(":")) {
    return address; // already prefixed: "megaeth:0x...", "algorand:..."
  } else if (address.startsWith("0x")) {
    return `ethereum:${address}`;
  } else {
    return `solana:${address}`;
  }
}

function parseDefiLlamaPriceMap(json: unknown): Map<string, number> {
  const prices = new Map<string, number>();
  const { coins } = DLPriceResponseSchema.parse(json);
  for (const [id, info] of Object.entries(coins)) {
    if (info.price > 0) {
      prices.set(id, info.price);
    }
  }
  return prices;
}

interface FetchPriceMapByIdsConfig {
  source: string;
  ids: string[];
  buildUrl: (ids: string[]) => string;
  parseResponse: (json: unknown) => Map<string, number>;
  signal?: AbortSignal;
  requestInit?: RequestInit;
  onFetchFailure?: (status: number | null) => void;
}

async function fetchPriceMapByIds(config: FetchPriceMapByIdsConfig): Promise<Map<string, number> | null> {
  if (config.ids.length === 0) return new Map();

  const requestInit: RequestInit = {
    ...(config.requestInit ?? {}),
    ...(config.signal ? { signal: config.signal } : {}),
  };
  const res = await fetchWithRetry(
    config.buildUrl(config.ids),
    Object.keys(requestInit).length > 0 ? requestInit : undefined,
  );
  if (!res?.ok) {
    config.onFetchFailure?.(res?.status ?? null);
    return null;
  }

  try {
    const json = await res.json();
    return config.parseResponse(json);
  } catch {
    console.error(`[enrich-prices] Failed to parse JSON from ${config.source}: ${res.status}`);
    return new Map();
  }
}

interface DexScreenerPair {
  baseToken: { symbol: string };
  quoteToken: { symbol: string };
  priceUsd: string;
  liquidity: { usd: number };
  chainId: string;
}

interface JupiterPriceEntry {
  usdPrice?: number;
  liquidity?: number;
  createdAt?: string | number;
}

interface DexScreenerTarget {
  chain: string;
  address: string;
}

const SOLANA_MINT_BY_ID = new Map<string, string>();
for (const [id, meta] of ACTIVE_META_BY_ID) {
  const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
  const solanaDeployment = deployments.find((deployment) => deployment.chain === "solana");
  if (solanaDeployment?.address) {
    SOLANA_MINT_BY_ID.set(id, solanaDeployment.address);
  }
}

const ADDRESS_CHAIN_ALIASES: Record<string, string> = {
  avax: "avalanche",
};

function resolveDexTargetChain(rawChain: string): string | null {
  const normalized = rawChain.trim().toLowerCase();
  return resolveChainId(ADDRESS_CHAIN_ALIASES[normalized] ?? normalized);
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
    const tokenAddress = rest.join(":").trim();
    pushTarget(resolveDexTargetChain(rawChain), tokenAddress);
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
  const sorted = [...prices].sort((a, b) => a - b);
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

  return isReasonablePrice(
    price,
    asset.pegType as string | undefined,
    fxRates,
    buildPriceReasonablenessOptions(asset),
  )
    ? price
    : null;
}

// ── Pass 1 + 1b: DefiLlama contract addresses ──────────────────────

/**
 * Resolve prices for assets that have a contract address via the
 * DefiLlama coins API. Pass 1b attempts multi-chain fallback for
 * Ethereum addresses that failed in pass 1.
 *
 * Throws on abort-signal; all other errors are caught internally
 * and reported via `failures`.
 */
export async function runDlContractPasses(
  assets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<DlContractPassResult> {
  let pass1Count = 0;
  let pass1bCount = 0;
  const failures: string[] = [];

  try {
    const withAddress: { index: number; coinId: string }[] = [];
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      if (!hasMissingPrice(a) || !a.address) continue;
      withAddress.push({ index: i, coinId: addressToCoinId(a.address) });
    }

    if (withAddress.length > 0) {
      throwIfAborted(signal);
      const pass1Prices = await fetchPriceMapByIds({
        source: "DefiLlama coins API (pass 1)",
        ids: withAddress.map((m) => m.coinId),
        buildUrl: (ids) => `${DEFILLAMA_COINS}/prices/current/${ids.join(",")}`,
        parseResponse: parseDefiLlamaPriceMap,
        signal,
      });
      if (pass1Prices) {
        for (const m of withAddress) {
          const price = pass1Prices.get(m.coinId);
          if (price != null) {
            applyResolvedPrice(assets[m.index], price, "defillama-contract", "single-source");
            pass1Count++;
          }
        }
      }
    }

    // ── Pass 1b: Multi-chain fallback for 0x addresses still missing ──
    const stillMissingAddr = withAddress.filter(
      (m) => hasMissingPrice(assets[m.index]) && m.coinId.startsWith("ethereum:")
    );
    if (stillMissingAddr.length > 0) {
      // Build alternate chain coinIds from the asset's chains field
      const altLookups: { index: number; coinId: string }[] = [];
      for (const m of stillMissingAddr) {
        const a = assets[m.index];
        const chains = a.chains as string[] | undefined;
        if (!chains || !a.address) continue;
        const addr = a.address;
        for (const chain of chains) {
          if (chain === "Ethereum") continue; // already tried
          const prefix = CHAIN_PREFIX_MAP[chain];
          if (prefix) {
            altLookups.push({ index: m.index, coinId: `${prefix}:${addr}` });
          }
        }
      }

      if (altLookups.length > 0) {
        throwIfAborted(signal);
        const pass1bPrices = await fetchPriceMapByIds({
          source: "DefiLlama coins API (pass 1b)",
          ids: altLookups.map((m) => m.coinId),
          buildUrl: (ids) => `${DEFILLAMA_COINS}/prices/current/${ids.join(",")}`,
          parseResponse: parseDefiLlamaPriceMap,
          signal,
        });
        if (pass1bPrices) {
          const resolved = new Set<number>(); // avoid double-count
          for (const m of altLookups) {
            if (resolved.has(m.index)) continue;
            const price = pass1bPrices.get(m.coinId);
            if (price != null) {
              applyResolvedPrice(assets[m.index], price, "defillama-contract", "single-source");
              pass1bCount++;
              resolved.add(m.index);
            }
          }
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[enrich-prices] Pass 1/1b (DefiLlama contracts) failed — continuing with CMC/DexScreener:", err);
    failures.push("dl-contracts");
  }

  return { resolved: pass1Count + pass1bCount, failures, pass1: pass1Count, pass1b: pass1bCount };
}

// ── Pass 2: CoinMarketCap ───────────────────────────────────────────

/**
 * Resolve prices for still-missing assets via the CoinMarketCap
 * stablecoin category listing. Rate-limited to 1 call per hour via
 * a D1 cache timestamp.
 *
 * This function does NOT catch errors — the caller is expected to
 * wrap it in the same try/catch that covers DexScreener (preserving
 * the original "passes-2-3" failure grouping).
 */
export async function runCmcPass(
  assets: PeggedAsset[],
  cmcApiKey: string | undefined,
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
): Promise<EnrichPassResult> {
  let resolved = 0;

  const missingAfterPass1b = assets
    .map((a, i) => ({ asset: a, index: i }))
    .filter((m) => hasMissingPrice(m.asset));

  const cmcAllowed =
    cmcApiKey != null && db != null
      ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.CMC_PRICES)
      : true;
  if (cmcApiKey && cmcAllowed && missingAfterPass1b.length > 0) {
    // Rate limit: max 1 CMC call per hour, tracked via cache table
    let shouldCall = true;
    if (db) {
      try {
        const row = await getCache(db, "cmc_last_fetch");
        if (row && (Math.floor(Date.now() / 1000) - row.updatedAt) < 3600) {
          shouldCall = false;
        }
      } catch (e) {
        console.warn("[enrich-prices] CMC rate-limit check failed, proceeding with call:", e);
      }
    }

    if (shouldCall) {
      const cmcTimeout = AbortSignal.timeout(CMC_REQUEST_TIMEOUT_MS);
      const cmcSignal = signal ? AbortSignal.any([signal, cmcTimeout]) : cmcTimeout;
      const cmcRes = await fetchWithRetry(
        "https://pro-api.coinmarketcap.com/v1/cryptocurrency/category?id=604f2753ebccdd50cd175fc1&limit=300&convert=USD",
        {
          headers: {
            "X-CMC_PRO_API_KEY": cmcApiKey,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          signal: cmcSignal,
        },
        CMC_MAX_RETRIES,
        { timeoutMs: CMC_REQUEST_TIMEOUT_MS },
      );

      if (cmcRes && cmcRes.ok) {
        const cmcData = (await cmcRes.json()) as {
          data: { coins: Array<{ slug?: string; symbol: string; quote: { USD: { price: number } } }> };
        };

        const cmcBySymbol = new Map<string, number>();
        const cmcBySlug = new Map<string, number>();
        for (const entry of cmcData.data.coins) {
          const price = entry.quote?.USD?.price;
          if (price != null && price > 0) {
            const sym = entry.symbol.toUpperCase();
            if (cmcBySymbol.has(sym)) {
              console.warn(`[enrich] CMC symbol collision: ${sym} (existing=$${cmcBySymbol.get(sym)}, new=$${price})`);
            }
            cmcBySymbol.set(sym, price);
            if (entry.slug) {
              cmcBySlug.set(entry.slug.toLowerCase(), price);
            }
          }
        }

        for (const m of missingAfterPass1b) {
          // Prefer slug-based matching to avoid symbol collisions
          const slug = m.asset.cmcSlug;
          const cmcPrice = slug
            ? cmcBySlug.get(slug.toLowerCase()) ?? cmcBySymbol.get(m.asset.symbol.toUpperCase())
            : cmcBySymbol.get(m.asset.symbol.toUpperCase());
          if (cmcPrice != null && isReasonablePrice(
            cmcPrice,
            m.asset.pegType as string | undefined,
            fxRates,
            buildPriceReasonablenessOptions(m.asset),
          )) {
            applyResolvedPrice(assets[m.index], cmcPrice, "coinmarketcap", "fallback");
            resolved++;
          }
        }

        // Update rate-limit timestamp
        if (db) {
          try {
            await setCache(db, "cmc_last_fetch", "1");
          } catch (e) {
            console.warn("[enrich-prices] Failed to update CMC rate-limit timestamp:", e);
          }
        }
        if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, true);
      } else {
        console.warn(`[enrich] CMC API returned ${cmcRes?.status ?? "no response"}`);
        if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, false);
      }
    }
  } else if (cmcApiKey && !cmcAllowed) {
    console.warn("[enrich] CoinMarketCap circuit open — skipping pass 2");
  }

  return { resolved, failures: [] };
}

// ── Pass 3: DexScreener ─────────────────────────────────────────────

/**
 * Best-effort fallback: try exact DexScreener token-pair lookups when the
 * asset has a usable chain+address, then fall back to symbol search.
 * Capped at {@link DEXSCREENER_MAX_REQUESTS} total requests with a total
 * pass budget of 45 seconds.
 *
 * Like {@link runCmcPass}, this does NOT catch errors — the caller
 * wraps it in the shared "passes-2-3" try/catch.
 */
export async function runDexScreenerPass(
  assets: PeggedAsset[],
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
): Promise<EnrichPassResult> {
  let resolved = 0;

  const stillMissing = assets
    .map((a, i) => ({ asset: a, index: i }))
    .filter((m) => hasMissingPrice(m.asset));

  if (stillMissing.length > DEXSCREENER_MAX_REQUESTS) {
    console.warn(`[enrich] ${stillMissing.length} assets still missing prices — capping DexScreener to ${DEXSCREENER_MAX_REQUESTS} requests`);
  }

  const dexscreenerAllowed =
    db != null ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES) : true;
  let dexAttempts = 0;
  let dexSuccessfulCalls = 0;
  if (dexscreenerAllowed) {
    const dexCandidates = stillMissing.slice(0, DEXSCREENER_MAX_REQUESTS);
    const dexBudgetDeadlineMs = Date.now() + DEXSCREENER_PASS_BUDGET_MS;
    for (const m of dexCandidates) {
      if (dexAttempts >= DEXSCREENER_MAX_REQUESTS) break;
      try {
        // DexScreener is the last, best-effort fallback. Keep the whole pass
        // time-bounded so a wave of missing prices cannot exhaust the cron slot.
        const remainingBudgetMs = dexBudgetDeadlineMs - Date.now();
        if (remainingBudgetMs <= 0) {
          console.warn(
            `[enrich] DexScreener pass budget exhausted after ${dexAttempts}/${DEXSCREENER_MAX_REQUESTS} requests`,
          );
          break;
        }

        let resolvedFromDex = false;
        const exactTargets = buildDexScreenerTargets(m.asset);
        for (const target of exactTargets) {
          if (dexAttempts >= DEXSCREENER_MAX_REQUESTS) break;
          const exactRemainingBudgetMs = dexBudgetDeadlineMs - Date.now();
          if (exactRemainingBudgetMs <= 0) break;

          if (dexAttempts > 0) {
            await sleepWithSignal(200, signal);
          }

          dexAttempts++;
          const { ok, pairs } = await fetchDsTokenPoolsWithStatus(
            target.chain,
            target.address,
            signal,
            Math.min(DEXSCREENER_REQUEST_TIMEOUT_MS, exactRemainingBudgetMs),
          );
          if (ok) dexSuccessfulCalls++;

          const exactPrice = resolveDexScreenerAddressPrice(m.asset, target.address, pairs, fxRates);
          if (exactPrice == null) continue;

          applyResolvedPrice(assets[m.index], exactPrice, "dexscreener", "fallback");
          resolved++;
          resolvedFromDex = true;
          break;
        }

        if (resolvedFromDex || dexAttempts >= DEXSCREENER_MAX_REQUESTS) {
          continue;
        }

        const searchRemainingBudgetMs = dexBudgetDeadlineMs - Date.now();
        if (searchRemainingBudgetMs <= 0) {
          console.warn(
            `[enrich] DexScreener pass budget exhausted after ${dexAttempts}/${DEXSCREENER_MAX_REQUESTS} requests`,
          );
          break;
        }

        if (dexAttempts > 0) {
          await sleepWithSignal(200, signal);
        }

        dexAttempts++;
        const res = await fetchWithRetry(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(m.asset.symbol)}`,
          { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
          DEXSCREENER_MAX_RETRIES,
          { timeoutMs: Math.min(DEXSCREENER_REQUEST_TIMEOUT_MS, searchRemainingBudgetMs) },
        );
        if (!res) {
          console.warn(`[enrich] DexScreener returned no response for ${m.asset.symbol}`);
          continue;
        }
        if (!res.ok) {
          console.warn(`[enrich] DexScreener returned ${res.status} for ${m.asset.symbol}`);
          continue;
        }
        dexSuccessfulCalls++;
        const data = (await res.json()) as { pairs?: DexScreenerPair[] };
        if (!data.pairs || data.pairs.length === 0) continue;

        // Filter: matching symbol, has USD price, >$50K liquidity
        const candidates = data.pairs.filter((p) => {
          if (p.baseToken.symbol.toUpperCase() !== m.asset.symbol.toUpperCase()) return false;
          if (!p.priceUsd || !p.liquidity?.usd) return false;
          if (p.liquidity.usd < DEXSCREENER_MIN_LIQUIDITY_USD) return false;
          return true;
        });

        if (candidates.length === 0) continue;

        // Take median price across qualifying pools (more robust than single max-liquidity pool)
        const price = medianDexPrice(
          candidates
          .map((c) => parseFloat(c.priceUsd))
          .filter((p) => !isNaN(p) && isFinite(p) && p > 0)
        );
        if (price == null) continue;
        // Sanity check: peg-type-aware range
        if (isReasonablePrice(
          price,
          m.asset.pegType as string | undefined,
          fxRates,
          buildPriceReasonablenessOptions(m.asset),
        )) {
          applyResolvedPrice(assets[m.index], price, "dexscreener", "fallback");
          resolved++;
        }
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
        console.warn(`[enrich] DexScreener failed for ${m.asset.symbol}:`, err);
      }
    }
    if (dexAttempts > 0) {
      if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES, dexSuccessfulCalls > 0);
    }
  } else if (stillMissing.length > 0) {
    console.warn("[enrich] DexScreener circuit open — skipping pass 3");
  }

  return { resolved, failures: [] };
}

// ── Pass 3: Jupiter Price API ───────────────────────────────────────

export async function runJupiterPass(
  assets: PeggedAsset[],
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
): Promise<EnrichPassResult> {
  let resolved = 0;
  const jupiterAllowed = db != null ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.JUPITER_PRICES) : true;
  if (!jupiterAllowed) {
    console.warn("[enrich] Jupiter circuit open — skipping pass 3");
    return { resolved, failures: [] };
  }

  const candidates = assets
    .map((asset, index) => ({ asset, index, mint: SOLANA_MINT_BY_ID.get(asset.id) }))
    .filter((entry) => hasMissingPrice(entry.asset) && entry.mint);
  if (candidates.length === 0) {
    return { resolved, failures: [] };
  }

  let successfulCalls = 0;
  for (let i = 0; i < candidates.length; i += JUPITER_MAX_IDS_PER_REQUEST) {
    const batch = candidates.slice(i, i + JUPITER_MAX_IDS_PER_REQUEST);
    const ids = batch.map((entry) => entry.mint!);

    const res = await fetchWithRetry(
      `${JUPITER_PRICE_API}?ids=${encodeURIComponent(ids.join(","))}`,
      { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
      JUPITER_MAX_RETRIES,
      { timeoutMs: JUPITER_REQUEST_TIMEOUT_MS },
    );
    if (!res?.ok) {
      console.warn(`[enrich] Jupiter returned ${res?.status ?? "no response"} for batch of ${ids.length}`);
      continue;
    }

    successfulCalls++;
    const data = (await res.json()) as Record<string, JupiterPriceEntry>;
    for (const entry of batch) {
      const payload = data[entry.mint!];
      const usdPrice = payload?.usdPrice;
      const liquidity = payload?.liquidity;
      if (usdPrice == null || !Number.isFinite(usdPrice) || usdPrice <= 0) continue;
      if (liquidity == null || !Number.isFinite(liquidity) || liquidity < JUPITER_MIN_LIQUIDITY_USD) continue;

      if (!isReasonablePrice(
        usdPrice,
        entry.asset.pegType as string | undefined,
        fxRates,
        buildPriceReasonablenessOptions(entry.asset),
      )) {
        continue;
      }

      // Jupiter Price API V3 documents blockId as the recency signal. Live
      // responses may still include createdAt metadata, but it is not a
      // reliable freshness guard for these fallback quotes.
      applyResolvedPrice(assets[entry.index], usdPrice, "jupiter", "fallback");
      resolved++;
    }
  }

  if (db) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.JUPITER_PRICES, successfulCalls > 0);
  }
  return { resolved, failures: [] };
}
