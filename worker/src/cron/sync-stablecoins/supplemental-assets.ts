import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { CIRCUIT_SOURCE, USER_AGENT } from "../../lib/constants";
import { cgHeaders, cgSimplePricePath, cgUrl } from "../../lib/coingecko";
import { throwIfAborted } from "../../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { PeggedAsset } from "./enrich-prices";
import { FIAT_CG_METAS, fetchFiatCoinGeckoTokens } from "./supplemental-assets/fiat-cg";
import { fetchGoldTokens } from "./supplemental-assets/gold";
import { fetchSilverTokens } from "./supplemental-assets/silver";

export type { CoinGeckoMcapData } from "./supplemental-assets/shared";
export {
  getSupplementalDefiLlamaContractPriceKey,
  resolveLowVolumeCoinGeckoPrice,
  resolveSupplementalContractPrice,
  resolveSupplementalPrice,
} from "./supplemental-assets/shared";
export {
  computeExcludedBalanceAdjustedSupplyRaw,
  selectSingleOnChainSupplyContract,
  selectSupplementalOnChainSupplyContract,
} from "./supplemental-assets/onchain-supply";

import type { CoinGeckoMcapData } from "./supplemental-assets/shared";

const COMMODITY_TOKENS = ACTIVE_STABLECOINS.filter(
  (stablecoin) => stablecoin.flags.pegCurrency === "GOLD" || stablecoin.flags.pegCurrency === "SILVER",
);

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

  const result = await fetchTextWithRetry(
    cgUrl(cgSimplePricePath(`ids=${ids}&vs_currencies=usd&include_market_cap=true&include_last_updated_at=true`), coingeckoApiKey ?? null),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
    2,
    { returnFinalResponse: true },
  );

  if (!result?.response.ok) {
    console.error(`[sync-stablecoins] CoinGecko batch mcap fetch failed: ${result?.response.status ?? "no response"}`);
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_MCAP, false);
    return {};
  }

  try {
    const data = JSON.parse(result.body) as CoinGeckoMcapData;
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_MCAP, true);
    return data;
  } catch (err) {
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
  db?: D1Database,
): Promise<{
  goldTokens: PeggedAsset[];
  silverTokens: PeggedAsset[];
  fiatCgTokens: PeggedAsset[];
}> {
  throwIfAborted(signal);
  // Keep supplemental families serial. This path overlaps with the main
  // DefiLlama stablecoins fetch, so gold's batched protocol reads, silver's CG
  // pair, and fiat-cg's on-chain fallbacks must not stack in one trigger.
  const goldTokens = await fetchGoldTokens(cgData, signal, db);
  const silverTokens = await fetchSilverTokens(cgData, signal, coingeckoApiKey, db);
  const fiatCgTokens = await fetchFiatCoinGeckoTokens(cgData, signal, chainRpcs, fxFallbackRates, db);

  return { goldTokens, silverTokens, fiatCgTokens };
}
