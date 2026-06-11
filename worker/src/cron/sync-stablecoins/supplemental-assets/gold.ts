import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { fetchWithRetry } from "../../../lib/fetch-retry";
import { CIRCUIT_SOURCE, DEFILLAMA_API, USER_AGENT } from "../../../lib/constants";
import { throwIfAborted } from "../../../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { cancelResponseBodyQuietly } from "../../../lib/response-body";
import type { PeggedAsset } from "../enrich-prices";
import {
  buildPricedSupplementalAsset,
  fetchSupplementalPriceData,
  toPositiveFiniteNumber,
  type CoinGeckoMcapData,
} from "./shared";

const GOLD_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "GOLD");

function findNearestTvl(
  history: { date: number; totalLiquidityUSD: number }[],
  targetSec: number,
): number | null {
  if (history.length === 0) return null;

  let closest: { date: number; totalLiquidityUSD: number } | null = null;
  let closestDist = Infinity;

  for (const point of history) {
    const dist = Math.abs(point.date - targetSec);
    if (dist < closestDist) {
      closestDist = dist;
      closest = point;
    }
  }

  return closest && closestDist < 2 * DAY_SECONDS ? closest.totalLiquidityUSD : null;
}

export async function fetchGoldTokens(cgData: CoinGeckoMcapData, signal?: AbortSignal, db?: D1Database): Promise<PeggedAsset[]> {
  throwIfAborted(signal);
  try {
    const priceData = await fetchSupplementalPriceData(GOLD_METAS, "gold", signal, db);

    const mcapMap: Record<string, number> = {};
    const mcapSourceById: Record<string, "defillama" | "coingecko-fallback"> = {};
    const tvlHistoryMap: Record<string, { date: number; totalLiquidityUSD: number }[]> = {};
    const tokensWithProtocol = GOLD_METAS.filter((token) => token.protocolSlug);
    const PROTOCOL_BATCH = 3;
    const protocolsAllowed = tokensWithProtocol.length > 0 && db
      ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_PROTOCOLS)
      : true;
    let protocolFetchAttempts = 0;
    let protocolFetchSuccesses = 0;

    if (!protocolsAllowed) {
      console.warn("[gold] DefiLlama protocols circuit open; using CoinGecko market-cap fallback when available");
    } else {
      for (let pi = 0; pi < tokensWithProtocol.length; pi += PROTOCOL_BATCH) {
        const batch = tokensWithProtocol.slice(pi, pi + PROTOCOL_BATCH);
        await Promise.all(batch.map(async (token) => {
          protocolFetchAttempts += 1;
          try {
            const res = await fetchWithRetry(`${DEFILLAMA_API}/protocol/${token.protocolSlug}`, {
              headers: { "User-Agent": USER_AGENT },
              signal,
            });
            if (!res || !res.ok) {
              await cancelResponseBodyQuietly(res);
              console.warn(`[sync-stablecoins] Protocol fetch failed for ${token.protocolSlug}: ${res?.status ?? "no response"}`);
              return;
            }

            const data = (await res.json()) as { mcap?: number; tvl?: { date: number; totalLiquidityUSD: number }[] };
            protocolFetchSuccesses += 1;
            if (data.mcap) {
              mcapMap[token.id] = data.mcap;
              mcapSourceById[token.id] = "defillama";
            }
            if (data.tvl) tvlHistoryMap[token.id] = data.tvl;
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            console.warn(`[sync-stablecoins] Protocol fetch failed for ${token.protocolSlug}:`, err);
          }
        }));
      }
      if (db && protocolFetchAttempts > 0) {
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.DL_PROTOCOLS, protocolFetchSuccesses > 0);
      }
    }

    for (const token of GOLD_METAS) {
      if (mcapMap[token.id] != null && mcapMap[token.id] > 0) continue;
      const mcap = token.geckoId ? toPositiveFiniteNumber(cgData[token.geckoId]?.usd_market_cap) : undefined;
      if (mcap != null) {
        mcapMap[token.id] = mcap;
        mcapSourceById[token.id] = "coingecko-fallback";
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const dayAgo = nowSec - DAY_SECONDS;
    const weekAgo = nowSec - 7 * DAY_SECONDS;
    const monthAgo = nowSec - 30 * DAY_SECONDS;

    return GOLD_METAS
      .map((meta) => {
        const mcap = mcapMap[meta.id] ?? 0;
        if (!mcap) {
          console.warn(`[gold] No mcap for ${meta.symbol}, including with mcap=0`);
        }

        const history = tvlHistoryMap[meta.id];
        let usableHistory: typeof history | undefined;

        if (history && history.length > 0 && mcap > 0) {
          const latestTvl = history[history.length - 1].totalLiquidityUSD;
          const ratio = mcap / latestTvl;
          if (ratio > 0.85 && ratio < 1.15) {
            usableHistory = history;
          } else {
            console.warn(`[gold] ${meta.symbol}: mcap/tvl divergence (ratio=${ratio.toFixed(3)}), skipping TVL history`);
          }
        }

        const prevDay = usableHistory ? findNearestTvl(usableHistory, dayAgo) : null;
        const prevWeek = usableHistory ? findNearestTvl(usableHistory, weekAgo) : null;
        const prevMonth = usableHistory ? findNearestTvl(usableHistory, monthAgo) : null;

        return buildPricedSupplementalAsset(meta, priceData, cgData, {
          mcap,
          supplySource: mcapSourceById[meta.id] ?? "coingecko-fallback",
          circulatingPrevDay: prevDay,
          circulatingPrevWeek: prevWeek,
          circulatingPrevMonth: prevMonth,
        });
      })
      .filter((token): token is PeggedAsset => token !== null);
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.error("[gold] fetchGoldTokens failed:", err);
    return [];
  }
}
