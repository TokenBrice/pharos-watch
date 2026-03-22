import { GT_API_BASE } from "./dex-constants";
import { RATE_LIMITS } from "./rate-limit";
import { fetchWithRetry } from "./fetch-retry";
import { USER_AGENT, GT_PROBE_MIN_TVL_USD, GT_PROBE_TIMEOUT_MS, CIRCUIT_SOURCE } from "./constants";
import { shouldAttemptFetch, recordOutcome } from "./circuit-breaker";
import { sleepWithSignal, throwIfAborted } from "./abort";
import { GT_CHAIN_MAP } from "@shared/lib/chain-provider-registry";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { GtPool } from "../cron/dex-liquidity/types";
import type { SourcePrice } from "./price-consensus";

export interface GtProbeResult {
  price: number;
  tvlUsd: number;
  side: "base" | "quote";
  chain: string;
  poolAddress: string;
}

/**
 * Extract the best price from a GeckoTerminal pools response for a given token address.
 * Picks the highest-TVL pool where the token matches base or quote, with a TVL gate.
 */
export function extractPoolPrice(
  pools: GtPool[],
  tokenAddress: string,
  minTvlUsd = GT_PROBE_MIN_TVL_USD,
): GtProbeResult | null {
  const normalized = tokenAddress.toLowerCase();
  let best: GtProbeResult | null = null;

  for (const pool of pools) {
    const a = pool.attributes;
    const tvl = parseFloat(a.reserve_in_usd ?? "");
    if (!Number.isFinite(tvl) || tvl < minTvlUsd) continue;

    const baseId = pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "";
    const quoteId = pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "";

    let price: number | null = null;
    let side: "base" | "quote" | null = null;

    if (baseId === normalized) {
      price = parseFloat(a.base_token_price_usd ?? "");
      side = "base";
    } else if (quoteId === normalized) {
      price = parseFloat(a.quote_token_price_usd ?? "");
      side = "quote";
    }

    if (side == null || price == null || !Number.isFinite(price) || price <= 0) continue;
    if (best == null || tvl > best.tvlUsd) {
      best = { price, tvlUsd: tvl, side, chain: "", poolAddress: a.address };
    }
  }

  return best;
}

export interface GtProbeStats {
  probed: number;
  pricesObtained: number;
  divergences500bps: number;
  skippedLowTvl: number;
  lookupMisses: number;
  upstreamErrors: number;
}

function isGtLookupMissStatus(status: number | undefined): boolean {
  return status === 404 || status === 422;
}

/**
 * Probe GeckoTerminal for independent pool-level prices for assets that are
 * single-source CG-only after primary consensus. Returns a map of asset ID
 * to SourcePrice for injection into a second-pass consensus.
 */
export async function probeGeckoTerminalPrices(
  singleSourceCgAssets: { id: string; price: number }[],
  db: D1Database,
  signal?: AbortSignal,
): Promise<{ prices: Map<string, SourcePrice>; stats: GtProbeStats }> {
  const prices = new Map<string, SourcePrice>();
  const stats: GtProbeStats = {
    probed: 0,
    pricesObtained: 0,
    divergences500bps: 0,
    skippedLowTvl: 0,
    lookupMisses: 0,
    upstreamErrors: 0,
  };

  if (singleSourceCgAssets.length === 0) return { prices, stats };

  const allowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE);
  if (!allowed) {
    console.warn("[gt-probe] Circuit open, skipping");
    return { prices, stats };
  }

  throwIfAborted(signal);

  const metaById = new Map(ACTIVE_STABLECOINS.map((m) => [m.id, m]));
  let failures = 0;

  for (const asset of singleSourceCgAssets) {
    throwIfAborted(signal);

    const meta = metaById.get(asset.id);
    if (!meta?.contracts?.length) continue;

    // Find first EVM contract with a GT chain mapping
    const contract = meta.contracts.find(
      (c) => c.chain !== "solana" && c.chain !== "stellar" && c.chain !== "tron" && GT_CHAIN_MAP[c.chain],
    );
    if (!contract) continue;

    const gtChain = GT_CHAIN_MAP[contract.chain];
    const url = `${GT_API_BASE}/networks/${gtChain}/tokens/${contract.address}/pools?page=1`;

    if (stats.probed > 0) {
      await sleepWithSignal(RATE_LIMITS.GECKO_TERMINAL_MS, signal);
    }

    stats.probed++;

    try {
      const res = await fetchWithRetry(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(GT_PROBE_TIMEOUT_MS)]) : AbortSignal.timeout(GT_PROBE_TIMEOUT_MS),
      }, 0);

      if (!res?.ok) {
        if (isGtLookupMissStatus(res?.status)) {
          stats.lookupMisses++;
          continue;
        }
        failures++;
        stats.upstreamErrors++;
        continue;
      }

      const json = (await res.json()) as { data?: GtPool[] };
      const pools = json.data ?? [];

      const result = extractPoolPrice(pools, contract.address);
      if (!result) {
        stats.skippedLowTvl++;
        continue;
      }

      result.chain = contract.chain;
      stats.pricesObtained++;

      // Track divergences for logging
      const mid = (result.price + asset.price) / 2;
      if (mid > 0) {
        const bps = Math.round((Math.abs(result.price - asset.price) / mid) * 10_000);
        if (bps >= 500) stats.divergences500bps++;
      }

      prices.set(asset.id, {
        source: "geckoterminal",
        price: result.price,
        weight: 1,
        metadata: { tvlUsd: result.tvlUsd, chain: result.chain, poolAddress: result.poolAddress, side: result.side },
      });
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      failures++;
      stats.upstreamErrors++;
      console.warn(`[gt-probe] Failed for ${asset.id}:`, String(err).slice(0, 200));
    }
  }

  // Source health should reflect GeckoTerminal reachability, not whether each
  // token lookup resolves to an indexed pool. 404/422 lookup misses are common
  // for thin assets and should not open the source-level circuit breaker.
  await recordOutcome(db, CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE, stats.probed === 0 || failures < stats.probed);

  console.log(
    `[gt-probe] Probed ${stats.probed} assets: ${stats.pricesObtained} prices obtained, ` +
    `${stats.divergences500bps} divergences >500bps, ${stats.skippedLowTvl} skipped (low TVL), ` +
    `${stats.lookupMisses} lookup misses, ${stats.upstreamErrors} upstream errors`,
  );

  return { prices, stats };
}
