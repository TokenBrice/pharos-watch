import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import { CIRCUIT_SOURCE, USER_AGENT } from "../../lib/constants";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { throwIfAborted } from "../../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { PeggedAsset } from "./enrich-prices";
import { fetchFiatCoinGeckoTokens } from "./supplemental-assets/fiat-cg";
import { fetchGoldTokens } from "./supplemental-assets/gold";
import { fetchSilverTokens } from "./supplemental-assets/silver";

export type { CoinGeckoMcapData } from "./supplemental-assets/shared";
export { resolveSupplementalPrice } from "./supplemental-assets/shared";
export {
  computeExcludedBalanceAdjustedSupplyRaw,
  selectSingleOnChainSupplyContract,
  selectSupplementalOnChainSupplyContract,
} from "./supplemental-assets/onchain-supply";

import type { CoinGeckoMcapData } from "./supplemental-assets/shared";

const COMMODITY_TOKENS = ACTIVE_STABLECOINS.filter(
  (stablecoin) => stablecoin.flags.pegCurrency === "GOLD" || stablecoin.flags.pegCurrency === "SILVER",
);

const FIAT_CG_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.detailProvider === "coingecko");

export async function fetchCoinGeckoMarketData(db: D1Database, signal?: AbortSignal, coingeckoApiKey?: string | null): Promise<CoinGeckoMcapData> {
  const ids = [
    // Protocol-backed commodity tokens still need CoinGecko spot + mcap fallback
    // when DefiLlama omits their `coins.llama.fi` price or protocol mcap.
    ...COMMODITY_TOKENS.map((token) => token.geckoId).filter(Boolean),
    ...FIAT_CG_METAS.map((token) => token.geckoId).filter(Boolean),
  ].join(",");

  if (!ids) return {};
  throwIfAborted(signal);

  const cgAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_MCAP);
  if (!cgAllowed) {
    console.warn("[sync-stablecoins] CoinGecko market-cap circuit open — skipping supplemental mcap fetch");
    return {};
  }

  const res = await fetchWithRetry(
    cgUrl(`/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true&include_last_updated_at=true`, coingeckoApiKey ?? null),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
  );

  if (!res || !res.ok) {
    await cancelResponseBodyQuietly(res);
    console.error(`[sync-stablecoins] CoinGecko batch mcap fetch failed: ${res?.status ?? "no response"}`);
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_MCAP, false);
    return {};
  }

  try {
    const data = (await res.json()) as CoinGeckoMcapData;
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_MCAP, true);
    return data;
  } catch (err) {
    await cancelResponseBodyQuietly(res);
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.error("[sync-stablecoins] CoinGecko batch mcap payload parse failed:", err);
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_MCAP, false);
    return {};
  }
}

export async function fetchSupplementalTrackedTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  fxFallbackRates?: Record<string, number>,
): Promise<{
  goldTokens: PeggedAsset[];
  silverTokens: PeggedAsset[];
  fiatCgTokens: PeggedAsset[];
}> {
  throwIfAborted(signal);
  // Two-phase fan-out so gold's own batched protocol fetches plus silver's
  // CG calls don't pile on top of fiat-cg simultaneously and exhaust the
  // Cloudflare 6-connection pool. Sockets opened in the first phase are
  // reclaimed before fiat-cg starts.
  const [goldTokens, silverTokens] = await Promise.all([
    fetchGoldTokens(cgData, signal),
    fetchSilverTokens(cgData, signal, coingeckoApiKey),
  ]);
  const fiatCgTokens = await fetchFiatCoinGeckoTokens(cgData, signal, chainRpcs, fxFallbackRates);

  return { goldTokens, silverTokens, fiatCgTokens };
}
