import {
  CIRCUIT_SOURCE,
  USER_AGENT,
} from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../lib/circuit-breaker";
import { getCache, setCache } from "../../lib/db-cache";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
} from "../../lib/price-validation";
import {
  applyResolvedPrice,
  hasMissingPrice,
  type PeggedAsset,
} from "./enrich-prices-shared";
import {
  type EnrichPassResult,
  UNIQUE_ACTIVE_SYMBOLS,
} from "./enrich-prices-pass-common";

const CMC_REQUEST_TIMEOUT_MS = 10_000;
const CMC_MAX_RETRIES = 0;

export async function runCmcPass(
  assets: PeggedAsset[],
  cmcApiKey: string | undefined,
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
): Promise<EnrichPassResult> {
  let resolved = 0;

  const missingAfterPass1b = assets
    .map((asset, index) => ({ asset, index }))
    .filter((entry) => hasMissingPrice(entry.asset));
  if (missingAfterPass1b.length === 0) {
    return { resolved, failures: [] };
  }

  const cmcAllowed =
    cmcApiKey != null && db != null
      ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.CMC_PRICES)
      : true;
  if (cmcApiKey && cmcAllowed) {
    let shouldCall = true;
    if (db) {
      try {
        const row = await getCache(db, "cmc_last_fetch");
        if (row && (Math.floor(Date.now() / 1000) - row.updatedAt) < 3600) {
          shouldCall = false;
        }
      } catch (error) {
        console.warn("[enrich-prices] CMC rate-limit check failed, proceeding with call:", error);
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

      if (cmcRes?.ok) {
        const cmcData = (await cmcRes.json()) as {
          data: { coins: Array<{ slug?: string; symbol: string; quote: { USD: { price: number } } }> };
        };
        const cmcBySymbol = new Map<string, number>();
        const cmcBySlug = new Map<string, number>();
        for (const entry of cmcData.data.coins) {
          const price = entry.quote?.USD?.price;
          if (price != null && price > 0) {
            const symbol = entry.symbol.toUpperCase();
            if (cmcBySymbol.has(symbol)) {
              console.warn(`[enrich] CMC symbol collision: ${symbol} (existing=$${cmcBySymbol.get(symbol)}, new=$${price})`);
            }
            cmcBySymbol.set(symbol, price);
            if (entry.slug) {
              cmcBySlug.set(entry.slug.toLowerCase(), price);
            }
          }
        }

        for (const entry of missingAfterPass1b) {
          const symbolKey = entry.asset.symbol.toUpperCase();
          const allowSymbolFallback = UNIQUE_ACTIVE_SYMBOLS.has(symbolKey);
          const slug = entry.asset.cmcSlug;
          const cmcPrice = slug
            ? cmcBySlug.get(slug.toLowerCase()) ?? (allowSymbolFallback ? cmcBySymbol.get(symbolKey) : undefined)
            : allowSymbolFallback
              ? cmcBySymbol.get(symbolKey)
              : undefined;
          if (cmcPrice != null && isReasonablePrice(
            cmcPrice,
            entry.asset.pegType as string | undefined,
            fxRates,
            buildPriceReasonablenessOptions(entry.asset),
          )) {
            applyResolvedPrice(assets[entry.index], cmcPrice, "coinmarketcap", "fallback");
            resolved += 1;
          }
        }

        if (db) {
          try {
            await setCache(db, "cmc_last_fetch", "1");
          } catch (error) {
            console.warn("[enrich-prices] Failed to update CMC rate-limit timestamp:", error);
          }
          await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, true);
        }
      } else {
        console.warn(`[enrich] CMC API returned ${cmcRes?.status ?? "no response"}`);
        if (db) {
          await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, false);
        }
      }
    }
  } else if (cmcApiKey && !cmcAllowed) {
    console.warn("[enrich] CoinMarketCap circuit open — skipping pass 2");
  }

  return { resolved, failures: [] };
}
