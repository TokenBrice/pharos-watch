import { GT_API_BASE } from "./dex-constants";
import { RATE_LIMITS } from "./rate-limit";
import { fetchWithRetry } from "./fetch-retry";
import { cancelResponseBodyQuietly } from "./response-body";
import { cgHeaders, cgUrl } from "./coingecko";
import {
  USER_AGENT,
  GT_PROBE_MIN_TVL_USD,
  GT_PROBE_TIMEOUT_MS,
  GT_PROBE_MAX_RETRIES,
  GT_PROBE_RUN_BUDGET_MS,
  CIRCUIT_SOURCE,
} from "./constants";
import { shouldAttemptFetch, recordOutcome } from "./circuit-breaker";
import { sleepWithSignal, throwIfAborted } from "./abort";
import { CG_CHAIN_MAP, GT_CHAIN_MAP } from "@shared/lib/chain-provider-registry";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { GtPool } from "../cron/dex-liquidity/types";
import type { SourcePrice } from "./price-consensus";
import { aggregateProtocolPrices, computeWeightedMedianPrice } from "./dex-price-estimators";

export interface GtProbeResult {
  price: number;
  tvlUsd: number;
  side: "base" | "quote";
  chain: string;
  poolAddress: string;
  protocolCount: number;
}

type ProbeTransport = "coingecko-onchain" | "geckoterminal-public";

interface GtProbeTransportStats {
  attempted: number;
  priced: number;
  lookupMisses: number;
  upstreamErrors: number;
}

/**
 * Extract a robust protocol-aware price from a GeckoTerminal pools response for a
 * given token address. Pools are first collapsed to one price per protocol via a
 * TVL-weighted median, then the final cross-protocol price is chosen as the
 * TVL-weighted median across those protocol groups.
 */
export function extractPoolPrice(
  pools: GtPool[],
  tokenAddress: string,
  minTvlUsd = GT_PROBE_MIN_TVL_USD,
): GtProbeResult | null {
  const normalized = tokenAddress.toLowerCase();
  const observations: Array<{
    protocol: string;
    price: number;
    tvl: number;
    poolAddress: string;
    side: "base" | "quote";
  }> = [];

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
    observations.push({
      protocol: pool.relationships.dex.data.id,
      price,
      tvl,
      poolAddress: a.address,
      side,
    });
  }

  const protocolGroups = aggregateProtocolPrices(observations);
  if (protocolGroups.length === 0) return null;

  const price = computeWeightedMedianPrice(
    protocolGroups.map((group) => ({
      price: group.price,
      weight: group.tvl,
    })),
  );
  if (price == null) return null;

  const representativeGroup = protocolGroups[0]!;
  const totalTvl = protocolGroups.reduce((sum, group) => sum + group.tvl, 0);
  return {
    price,
    tvlUsd: totalTvl,
    side: representativeGroup.representativeSide ?? "base",
    chain: "",
    poolAddress: representativeGroup.representativePoolAddress ?? "",
    protocolCount: protocolGroups.length,
  };
}

export interface GtProbeStats {
  probed: number;
  pricesObtained: number;
  divergences500bps: number;
  skippedLowTvl: number;
  lookupMisses: number;
  upstreamErrors: number;
  publicFallbacks: number;
  budgetExhausted: boolean;
  budgetSkipped: number;
  transports: {
    coingeckoOnchain: GtProbeTransportStats;
    geckoTerminalPublic: GtProbeTransportStats;
  };
}

export function createEmptyGtProbeStats(): GtProbeStats {
  return {
    probed: 0,
    pricesObtained: 0,
    divergences500bps: 0,
    skippedLowTvl: 0,
    lookupMisses: 0,
    upstreamErrors: 0,
    publicFallbacks: 0,
    budgetExhausted: false,
    budgetSkipped: 0,
    transports: {
      coingeckoOnchain: {
        attempted: 0,
        priced: 0,
        lookupMisses: 0,
        upstreamErrors: 0,
      },
      geckoTerminalPublic: {
        attempted: 0,
        priced: 0,
        lookupMisses: 0,
        upstreamErrors: 0,
      },
    },
  };
}

function isGtLookupMissStatus(status: number | undefined): boolean {
  return status === 404 || status === 422;
}

function getTransportStats(stats: GtProbeStats, transport: ProbeTransport): GtProbeTransportStats {
  return transport === "coingecko-onchain"
    ? stats.transports.coingeckoOnchain
    : stats.transports.geckoTerminalPublic;
}

type ProbeFetchOutcome =
  | { kind: "priced"; transport: ProbeTransport; result: GtProbeResult }
  | { kind: "lookup-miss"; transport: ProbeTransport }
  | { kind: "low-tvl"; transport: ProbeTransport }
  | { kind: "upstream-error"; transport: ProbeTransport };

interface ProbeableSingleSourceAsset {
  id: string;
  price: number;
  priorityUsd: number;
  chain: string;
  address: string;
  gtNetwork: string;
  cgNetwork?: string;
}

async function fetchProbeOutcome(
  transport: ProbeTransport,
  network: string,
  tokenAddress: string,
  stats: GtProbeStats,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<ProbeFetchOutcome> {
  const transportStats = getTransportStats(stats, transport);
  transportStats.attempted++;

  const url = transport === "coingecko-onchain"
    ? cgUrl(`/onchain/networks/${network}/tokens/${tokenAddress}/pools?include=base_token,quote_token&page=1`, coingeckoApiKey ?? null)
    : `${GT_API_BASE}/networks/${network}/tokens/${tokenAddress}/pools?page=1`;
  const headers = transport === "coingecko-onchain"
    ? cgHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" }, coingeckoApiKey ?? null)
    : { "User-Agent": USER_AGENT, Accept: "application/json" };

  try {
    const res = await fetchWithRetry(
      url,
      { headers, signal },
      GT_PROBE_MAX_RETRIES,
      { passthroughStatuses: [404, 422], timeoutMs: GT_PROBE_TIMEOUT_MS },
    );

    if (!res?.ok) {
      if (isGtLookupMissStatus(res?.status)) {
        transportStats.lookupMisses++;
        await cancelResponseBodyQuietly(res);
        return { kind: "lookup-miss", transport };
      }
      transportStats.upstreamErrors++;
      await cancelResponseBodyQuietly(res);
      return { kind: "upstream-error", transport };
    }

    const json = (await res.json()) as { data?: GtPool[] };
    const pools = Array.isArray(json.data) ? json.data : [];
    if (pools.length === 0) {
      transportStats.lookupMisses++;
      return { kind: "lookup-miss", transport };
    }

    const result = extractPoolPrice(pools, tokenAddress);
    if (!result) {
      return { kind: "low-tvl", transport };
    }

    transportStats.priced++;
    return { kind: "priced", transport, result };
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    transportStats.upstreamErrors++;
    return { kind: "upstream-error", transport };
  }
}

/**
 * Probe GeckoTerminal for independent pool-level prices for assets that are
 * single-source CG-only after primary consensus. Returns a map of asset ID
 * to SourcePrice for injection into a second-pass consensus.
 */
export async function probeGeckoTerminalPrices(
  singleSourceCgAssets: { id: string; price: number; priorityUsd?: number }[],
  db: D1Database,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<{ prices: Map<string, SourcePrice>; stats: GtProbeStats }> {
  const prices = new Map<string, SourcePrice>();
  const stats = createEmptyGtProbeStats();

  if (singleSourceCgAssets.length === 0) return { prices, stats };

  const allowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE);
  if (!allowed) {
    console.warn("[gt-probe] Circuit open, skipping");
    return { prices, stats };
  }

  throwIfAborted(signal);

  const metaById = new Map(ACTIVE_STABLECOINS.map((m) => [m.id, m]));
  const candidates: ProbeableSingleSourceAsset[] = [];
  for (const asset of singleSourceCgAssets) {
    const meta = metaById.get(asset.id);
    if (!meta?.contracts?.length) continue;

    const contract = meta.contracts.find(
      (entry) => entry.chain !== "solana" && entry.chain !== "stellar" && entry.chain !== "tron" && GT_CHAIN_MAP[entry.chain],
    );
    if (!contract) continue;

    candidates.push({
      id: asset.id,
      price: asset.price,
      priorityUsd: asset.priorityUsd ?? 0,
      chain: contract.chain,
      address: contract.address,
      gtNetwork: GT_CHAIN_MAP[contract.chain],
      cgNetwork: coingeckoApiKey ? CG_CHAIN_MAP[contract.chain] : undefined,
    });
  }
  candidates.sort((left, right) => {
    if (right.priorityUsd !== left.priorityUsd) return right.priorityUsd - left.priorityUsd;
    return left.id.localeCompare(right.id);
  });

  if (candidates.length === 0) {
    await recordOutcome(db, CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE, true);
    return { prices, stats };
  }

  let failures = 0;
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => {
    budgetController.abort(new Error("GT probe run budget exhausted"));
  }, GT_PROBE_RUN_BUDGET_MS);
  const probeSignal = signal
    ? AbortSignal.any([signal, budgetController.signal])
    : budgetController.signal;
  const markBudgetExhausted = (skippedCount: number) => {
    stats.budgetExhausted = true;
    stats.budgetSkipped = Math.max(stats.budgetSkipped, skippedCount);
  };

  try {
    for (let index = 0; index < candidates.length; index++) {
      throwIfAborted(signal);
      if (budgetController.signal.aborted) {
        markBudgetExhausted(candidates.length - index);
        break;
      }
      const asset = candidates[index];

      if (stats.probed > 0) {
        try {
          await sleepWithSignal(RATE_LIMITS.GECKO_TERMINAL_MS, probeSignal);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          if (budgetController.signal.aborted) {
            markBudgetExhausted(candidates.length - index);
            break;
          }
          throw err instanceof Error ? err : new Error(String(err));
        }
      }
      if (budgetController.signal.aborted) {
        markBudgetExhausted(candidates.length - index);
        break;
      }

      stats.probed++;

      try {
        const outcomes: ProbeFetchOutcome[] = [];
        let pricedOutcome: Extract<ProbeFetchOutcome, { kind: "priced" }> | null = null;

        if (asset.cgNetwork) {
          const onchainOutcome = await fetchProbeOutcome(
            "coingecko-onchain",
            asset.cgNetwork,
            asset.address,
            stats,
            probeSignal,
            coingeckoApiKey,
          );
          if (onchainOutcome.kind === "priced") {
            pricedOutcome = onchainOutcome;
          } else {
            outcomes.push(onchainOutcome);
          }
        }

        if (!pricedOutcome) {
          if (asset.cgNetwork) stats.publicFallbacks++;
          const publicOutcome = await fetchProbeOutcome(
            "geckoterminal-public",
            asset.gtNetwork,
            asset.address,
            stats,
            probeSignal,
          );
          if (publicOutcome.kind === "priced") {
            pricedOutcome = publicOutcome;
          } else {
            outcomes.push(publicOutcome);
          }
        }

        if (!pricedOutcome) {
          if (outcomes.some((outcome) => outcome.kind === "low-tvl")) {
            stats.skippedLowTvl++;
            continue;
          }
          if (outcomes.some((outcome) => outcome.kind === "lookup-miss")) {
            stats.lookupMisses++;
            continue;
          }
          failures++;
          stats.upstreamErrors++;
          continue;
        }

        const result = pricedOutcome.result;
        result.chain = asset.chain;
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
          observedAt: Math.floor(Date.now() / 1000),
          observedAtMode: "local_fetch",
          metadata: {
            tvlUsd: result.tvlUsd,
            chain: result.chain,
            poolAddress: result.poolAddress,
            side: result.side,
            protocolCount: result.protocolCount,
            transport: pricedOutcome.transport,
          },
        });
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
        if (budgetController.signal.aborted) {
          markBudgetExhausted(candidates.length - (index + 1));
          break;
        }
        failures++;
        stats.upstreamErrors++;
        console.warn(`[gt-probe] Failed for ${asset.id}:`, String(err).slice(0, 200));
      }
    }
  } finally {
    clearTimeout(budgetTimer);
  }

  // Source health should reflect GeckoTerminal reachability, not whether each
  // token lookup resolves to an indexed pool. 404/422 lookup misses are common
  // for thin assets and should not open the source-level circuit breaker.
  await recordOutcome(db, CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE, stats.probed === 0 || failures < stats.probed);
  if (stats.budgetExhausted) {
    console.warn(
      `[gt-probe] Budget exhausted after probing ${stats.probed}/${candidates.length} assets; ` +
      `skipped ${stats.budgetSkipped} remaining candidate${stats.budgetSkipped === 1 ? "" : "s"}`,
    );
  }

  console.log(
    `[gt-probe] Probed ${stats.probed} assets: ${stats.pricesObtained} prices obtained, ` +
    `${stats.divergences500bps} divergences >500bps, ${stats.skippedLowTvl} skipped (low TVL), ` +
    `${stats.lookupMisses} lookup misses, ${stats.upstreamErrors} upstream errors, ` +
    `${stats.publicFallbacks} public fallbacks, budget exhausted=${stats.budgetExhausted}, ` +
    `budget skipped=${stats.budgetSkipped}, onchain ${stats.transports.coingeckoOnchain.attempted}/${stats.transports.coingeckoOnchain.priced} priced, ` +
    `public ${stats.transports.geckoTerminalPublic.attempted}/${stats.transports.geckoTerminalPublic.priced} priced`,
  );

  return { prices, stats };
}
