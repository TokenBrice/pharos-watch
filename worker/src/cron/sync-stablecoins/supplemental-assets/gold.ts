import { logWorkerEventArgs } from "../../../lib/structured-log";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { fetchTextWithRetry } from "../../../lib/fetch-retry";
import { CIRCUIT_SOURCE, DEFILLAMA_API, USER_AGENT } from "../../../lib/constants";
import { throwIfAborted } from "../../../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../../lib/circuit-breaker";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import type { PeggedAsset } from "../enrich-prices";
import {
  buildPricedSupplementalAsset,
  fetchSupplementalPriceData,
  resolveCuratedAggregateSupplementalSupply,
  toPositiveFiniteNumber,
  type CoinGeckoMcapData,
} from "./shared";

const GOLD_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "GOLD");

export async function fetchGoldTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  db?: D1Database,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<PeggedAsset[]> {
  throwIfAborted(signal);
  try {
    const priceData = await fetchSupplementalPriceData(GOLD_METAS, "gold", signal, db);

    const mcapMap: Record<string, number> = {};
    const mcapSourceById: Record<string, "defillama" | "coingecko-fallback"> = {};
    const tokensWithProtocol = GOLD_METAS.filter((token) => token.protocolSlug);
    const PROTOCOL_BATCH = 3;
    const protocolsAllowed = tokensWithProtocol.length > 0 && db
      ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_PROTOCOLS)
      : true;
    let protocolFetchAttempts = 0;
    let protocolFetchSuccesses = 0;

    if (!protocolsAllowed) {
      logWorkerEventArgs("handler", "warn", "[gold] DefiLlama protocols circuit open; using CoinGecko market-cap fallback when available");
    } else {
      for (let pi = 0; pi < tokensWithProtocol.length; pi += PROTOCOL_BATCH) {
        const batch = tokensWithProtocol.slice(pi, pi + PROTOCOL_BATCH);
        await Promise.all(batch.map(async (token) => {
          protocolFetchAttempts += 1;
          try {
            const result = await fetchTextWithRetry(
              `${DEFILLAMA_API}/protocol/${token.protocolSlug}`,
              {
                headers: { "User-Agent": USER_AGENT },
                signal,
              },
              2,
              { returnFinalResponse: true },
            );
            if (!result?.response.ok) {
              logWorkerEventArgs("handler", "warn", `[sync-stablecoins] Protocol fetch failed for ${token.protocolSlug}: ${result?.response.status ?? "no response"}`);
              return;
            }

            const data = JSON.parse(result.body) as { mcap?: number };
            protocolFetchSuccesses += 1;
            if (data.mcap) {
              mcapMap[token.id] = data.mcap;
              mcapSourceById[token.id] = "defillama";
            }
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            logWorkerEventArgs("handler", "warn", `[sync-stablecoins] Protocol fetch failed for ${token.protocolSlug}:`, err);
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

    // Commodity upstreams publish an aggregate market cap with no per-chain
    // split, so curated aggregate probes are the only per-chain supply path
    // here. Keep them serial: this lane shares the trigger connection pool.
    const tokens: PeggedAsset[] = [];
    for (const meta of GOLD_METAS) {
      const aggregate = await resolveCuratedAggregateSupplementalSupply(meta, priceData, cgData, chainRpcs, signal);
      const mcap = aggregate?.mcap ?? mcapMap[meta.id] ?? 0;
      if (!mcap) {
        logWorkerEventArgs("handler", "warn", `[gold] No mcap for ${meta.symbol}, including with mcap=0`);
      }

      const token = buildPricedSupplementalAsset(meta, priceData, cgData, {
        mcap,
        supplySource: aggregate?.supplySource ?? mcapSourceById[meta.id] ?? "coingecko-fallback",
        chainCirculating: aggregate?.chainCirculating,
      });
      if (token) tokens.push(token);
    }

    return tokens;
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("handler", "error", "[gold] fetchGoldTokens failed:", err);
    return [];
  }
}
