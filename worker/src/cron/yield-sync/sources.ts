import { getChainRpc } from "../../lib/chain-registry";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import {
  CIRCUIT_SOURCE,
  RISK_FREE_RATE_FALLBACK,
  USER_AGENT,
} from "../../lib/constants";
import { getCache } from "../../lib/db";
import { recordOutcome, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchWithRetry } from "../../lib/fetch-retry";
import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types";
import { ON_CHAIN_RATE_CONFIGS } from "../yield-config";
import { computeApyFromPrice } from "../yield-helpers";
import {
  parseDlStablecoinPoolsCache,
  parseRiskFreeRateCache,
} from "./cache";
import type { DlPool, JsonRpcCallResponse, ResolvedYield } from "./types";

const DL_YIELDS_URL = "https://yields.llama.fi/pools";
const BPROTOCOL_LQTY_ONLY_SOURCE_KEY = "bprotocol-lqty-only";
const BPROTOCOL_LQTY_ONLY_SOURCE_LABEL = "B.Protocol Stability Pool (LQTY only)";
const BPROTOCOL_LQTY_ONLY_SOURCE_TYPE = "lending-vault";
const LIQUITY_STABILITY_POOL_TOTAL_LQTY_REWARD = 32_000_000;
const LIQUITY_DAILY_LQTY_ISSUANCE_FACTOR = 1 - Math.pow(0.5, 1 / 365);
const LIQUITY_COMMUNITY_ISSUANCE = "0xD8c9D9071123a059C6E0A945cF0e0c82b508d816";
const LIQUITY_STABILITY_POOL = "0x66017D22b0f8556afDd19FC67041899Eb65a21bb";
const LIQUITY_TOTAL_LQTY_ISSUED_SELECTOR = "0xb140384b";
const LIQUITY_TOTAL_LUSD_DEPOSITS_SELECTOR = "0x9bf2f1ac";
const LIQUITY_LQTY_GECKO_ID = "liquity";

export async function loadDlStablecoinPools(
  db: D1Database,
  signal?: AbortSignal,
): Promise<{ pools: DlPool[]; meta: YieldSourceInputMeta }> {
  const nowSec = Math.floor(Date.now() / 1000);
  let dlPools: DlPool[] = [];
  let fallbackMode: string | null = null;
  const cachedPools = await getCache(db, "dl-stablecoin-pools");
  if (cachedPools) {
    const parsed = parseDlStablecoinPoolsCache(cachedPools.value, cachedPools.updatedAt, nowSec);
    if (parsed) {
      dlPools = parsed.pools;
      console.log(`[sync-yield-data] Using ${dlPools.length} cached stablecoin pools from DEX sync`);
      return parsed;
    } else {
      console.warn("[sync-yield-data] Failed to parse cached DL pools, falling back to direct fetch");
      fallbackMode = "cache-parse-failed";
    }
  }

  if (dlPools.length === 0 && (await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_YIELDS))) {
    try {
      const res = await fetchWithRetry(DL_YIELDS_URL, {
        headers: { "User-Agent": USER_AGENT },
        signal,
      });
      if (res?.ok) {
        const body = (await res.json()) as { data: DlPool[] };
        dlPools = (body.data ?? []).filter((pool) => pool.stablecoin);
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, true);
        return {
          pools: dlPools,
          meta: {
            mode: "direct-fetch",
            updatedAt: nowSec,
            ageSeconds: 0,
            poolCount: dlPools.length,
            fallbackMode,
          },
        };
      } else {
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
        fallbackMode = "direct-fetch-failed";
      }
    } catch (error) {
      console.warn("[sync-yield-data] DL yields direct fetch failed:", error);
      await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
      fallbackMode = "direct-fetch-exception";
    }
  } else if (dlPools.length === 0) {
    fallbackMode = "circuit-open";
  }

  return {
    pools: dlPools,
    meta: {
      mode: "unavailable",
      updatedAt: cachedPools?.updatedAt ?? null,
      ageSeconds: cachedPools ? Math.max(0, nowSec - cachedPools.updatedAt) : null,
      poolCount: dlPools.length,
      fallbackMode,
    },
  };
}

export async function fetchOnChainRates(
  signal?: AbortSignal,
): Promise<Map<string, { rate: number }>> {
  const results = new Map<string, { rate: number }>();

  for (const config of ON_CHAIN_RATE_CONFIGS) {
    try {
      const rpc = getChainRpc(config.chain);
      if (!rpc) {
        console.warn(`[yield] No RPC for chain ${config.chain}`);
        continue;
      }

      const callData = config.selector + config.inputAmount.replace("0x", "").padStart(64, "0");
      const res = await fetchWithRetry(rpc.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [{ to: config.contract, data: callData }, "latest"],
          id: 1,
        }),
      });

      if (!res?.ok) continue;
      const body = (await res.json()) as { result?: string };
      if (!body.result || body.result === "0x") continue;

      const raw = BigInt(body.result);
      const rate = Number(raw) / 10 ** config.decimals;
      results.set(config.stablecoinId, { rate });
    } catch (error) {
      console.warn(`[yield] On-chain rate failed for ${config.stablecoinId}:`, error);
    }
  }

  return results;
}

async function fetchEthCallUint256(
  rpcUrl: string,
  to: string,
  data: string,
  signal?: AbortSignal,
): Promise<bigint | null> {
  try {
    const res = await fetchWithRetry(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to, data }, "latest"],
        id: 1,
      }),
    });

    if (!res?.ok) return null;

    const body = (await res.json()) as JsonRpcCallResponse;
    if (!body.result || body.error || body.result === "0x") return null;
    return BigInt(body.result);
  } catch (error) {
    console.warn(`[yield] eth_call failed for ${to} ${data}:`, error);
    return null;
  }
}

async function fetchCoinGeckoUsdPrice(
  geckoId: string,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const res = await fetchWithRetry(
      cgUrl(`/simple/price?ids=${encodeURIComponent(geckoId)}&vs_currencies=usd`),
      {
        headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }),
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
): Promise<ResolvedYield | null> {
  const rpc = getChainRpc("ethereum");
  if (!rpc) {
    console.warn("[yield] No Ethereum RPC configured for B.Protocol LQTY-only source");
    return null;
  }

  try {
    const lqtyPriceUsd = await fetchCoinGeckoUsdPrice(LIQUITY_LQTY_GECKO_ID, signal);
    if (lqtyPriceUsd == null) return null;

    let totalLusdDepositsRaw: bigint | null = null;
    let totalLqtyIssuedRaw: bigint | null = null;
    const rpcUrls = [rpc.rpcUrl, rpc.fallbackRpcUrl].filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    );

    for (const rpcUrl of rpcUrls) {
      const [lusdDeposits, lqtyIssued] = await Promise.all([
        fetchEthCallUint256(rpcUrl, LIQUITY_STABILITY_POOL, LIQUITY_TOTAL_LUSD_DEPOSITS_SELECTOR, signal),
        fetchEthCallUint256(rpcUrl, LIQUITY_COMMUNITY_ISSUANCE, LIQUITY_TOTAL_LQTY_ISSUED_SELECTOR, signal),
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
      sourceKey: BPROTOCOL_LQTY_ONLY_SOURCE_KEY,
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

export async function getPriceDerivedApy(
  db: D1Database,
  stablecoinId: string,
): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;

  const [recentRow, oldRow] = await Promise.all([
    db
      .prepare(
        "SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
      )
      .bind(stablecoinId)
      .first<{ price: number }>(),
    db
      .prepare(
        "SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL AND snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 1",
      )
      .bind(stablecoinId, thirtyDaysAgo)
      .first<{ price: number }>(),
  ]);

  if (!recentRow?.price || !oldRow?.price || oldRow.price <= 0) return null;
  return computeApyFromPrice(recentRow.price, oldRow.price, 30);
}

export async function loadRiskFreeRateSnapshot(db: D1Database): Promise<YieldBenchmarkMeta> {
  const rfCache = await getCache(db, "risk_free_rate");
  if (rfCache) {
    const parsed = parseRiskFreeRateCache(rfCache.value, rfCache.updatedAt);
    if (parsed) return parsed;
  }

  return {
    rate: RISK_FREE_RATE_FALLBACK,
    recordDate: null,
    fetchedAt: null,
    ageSeconds: null,
    source: "hardcoded-fallback",
    isFallback: true,
    fallbackMode: rfCache ? "invalid-cache" : "missing-cache",
  };
}
