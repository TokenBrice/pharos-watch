import {
  CIRCUIT_SOURCE,
  USER_AGENT,
} from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import {
  applyJsonParseFailureDiagnostic,
  applyNonOkProviderDiagnostic,
  buildPricingProviderDiagnostic,
  isProviderCircuitAllowed,
  recoverProviderOnNoCandidates,
  recordProviderOutcomeSafe,
  responseFromBufferedBody,
} from "../../lib/pricing-provider-lifecycle";
import { getCache, setCache } from "../../lib/db-cache";
import { CmcCategoryResponseSchema } from "../../lib/schemas";
import {
  endpointLabel,
  type PricingProviderAttemptDiagnostic,
} from "../../lib/pricing-provider-diagnostics";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
} from "../../lib/price-validation";
import {
  applyResolvedPrice,
  type PeggedAsset,
} from "./enrich-prices-shared";
import {
  collectMissingPriceCandidates,
  type EnrichPassResult,
  type FallbackPriceQuote,
  isFreshFallbackObservedAt,
  parseUnixOrIsoTimestampSec,
  UNIQUE_ACTIVE_SYMBOLS,
} from "./enrich-prices-pass-common";

const CMC_REQUEST_TIMEOUT_MS = 10_000;
const CMC_MAX_RETRIES = 0;
const CMC_CATEGORY_LIMIT = 300;
const CMC_QUOTE_MAX_AGE_SEC = 60 * 60;
const CMC_FETCH_COOLDOWN_SEC = 3600;
const CMC_PASSTHROUGH_STATUSES = [400, 401, 403, 404, 408, 409, 418, 425, 429, 451, 500, 502, 503, 504];
const CMC_CATEGORY_ENDPOINT = "pro-api.coinmarketcap.com/v1/cryptocurrency/category";
const CMC_STABLECOIN_CATEGORY_ID = "604f2753ebccdd50cd175fc1";
const CMC_LAST_FETCH_CACHE_KEY = "cmc_last_fetch";

interface CmcFallbackQuote extends FallbackPriceQuote {
  observedAt: number;
  symbol: string;
  slug?: string;
}

async function markCmcFetchCooldown(db: D1Database | undefined, reason: string): Promise<void> {
  if (!db) return;
  try {
    await setCache(db, CMC_LAST_FETCH_CACHE_KEY, "1");
  } catch (error) {
    console.warn(`[enrich-prices] Failed to update CMC rate-limit timestamp after ${reason}:`, error);
  }
}

export async function runCmcPass(
  assets: PeggedAsset[],
  cmcApiKey: string | undefined,
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
): Promise<EnrichPassResult> {
  let resolved = 0;
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];
  const recordFailureAndReturn = async (): Promise<EnrichPassResult> => {
    await recordProviderOutcomeSafe({
      db,
      circuitSource: CIRCUIT_SOURCE.CMC_PRICES,
      attempted: 1,
      successful: 0,
    });
    return { resolved, failures: [], diagnostics };
  };

  const missingAfterPass1b = collectMissingPriceCandidates(assets);
  if (missingAfterPass1b.length === 0) {
    await recoverProviderOnNoCandidates({
      db,
      circuitSource: CIRCUIT_SOURCE.CMC_PRICES,
      diagnostic: {
        source: "coinmarketcap",
        stage: "no-candidates",
        endpoint: CMC_CATEGORY_ENDPOINT,
      },
      diagnostics,
    });
    return diagnostics.length > 0 ? { resolved, failures: [], diagnostics } : { resolved, failures: [] };
  }

  const cmcAllowed = cmcApiKey
    ? await isProviderCircuitAllowed({
        db,
        circuitSource: CIRCUIT_SOURCE.CMC_PRICES,
        diagnostic: {
          source: "coinmarketcap",
          stage: "fallback",
          endpoint: CMC_CATEGORY_ENDPOINT,
          candidateCount: missingAfterPass1b.length,
        },
        diagnostics,
        errorMessage: "CoinMarketCap circuit open",
      })
    : true;
  if (cmcApiKey && cmcAllowed) {
    let shouldCall = true;
    if (db) {
      try {
        const row = await getCache(db, CMC_LAST_FETCH_CACHE_KEY);
        if (row && (Math.floor(Date.now() / 1000) - row.updatedAt) < CMC_FETCH_COOLDOWN_SEC) {
          shouldCall = false;
        }
      } catch (error) {
        console.warn("[enrich-prices] CMC rate-limit check failed, proceeding with call:", error);
      }
    }

    if (shouldCall) {
      const url = `https://${CMC_CATEGORY_ENDPOINT}?id=${CMC_STABLECOIN_CATEGORY_ID}&limit=${CMC_CATEGORY_LIMIT}&convert=USD`;
      const cmcTimeout = AbortSignal.timeout(CMC_REQUEST_TIMEOUT_MS);
      const cmcSignal = signal ? AbortSignal.any([signal, cmcTimeout]) : cmcTimeout;
      const cmcResult = await fetchTextWithRetry(
        url,
        {
          headers: {
            "X-CMC_PRO_API_KEY": cmcApiKey,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          signal: cmcSignal,
        },
        CMC_MAX_RETRIES,
        {
          timeoutMs: CMC_REQUEST_TIMEOUT_MS,
          passthroughStatuses: CMC_PASSTHROUGH_STATUSES,
          returnFinalResponse: true,
        },
      );
      const diagnostic: PricingProviderAttemptDiagnostic = buildPricingProviderDiagnostic({
        source: "coinmarketcap",
        stage: "fallback",
        endpoint: endpointLabel(url),
        candidateCount: missingAfterPass1b.length,
      }, {
        status: cmcResult?.response.status ?? null,
        ok: cmcResult?.response.ok === true,
      });

      if (cmcResult?.response.ok) {
        let cmcJson: unknown;
        try {
          cmcJson = JSON.parse(cmcResult.body);
        } catch (error) {
          diagnostics.push(applyJsonParseFailureDiagnostic(diagnostic, error));
          return recordFailureAndReturn();
        }
        const parsed = CmcCategoryResponseSchema.safeParse(cmcJson);
        if (!parsed.success) {
          diagnostics.push({
            ...diagnostic,
            errorClass: "invalid-shape",
            errorMessage: "Expected CoinMarketCap category payload with data.num_tokens and quote timestamps",
            rejectionReasonCounts: { "invalid-shape": 1 },
          });
          return recordFailureAndReturn();
        }
        const cmcData = parsed.data;
        if (
          cmcData.data.num_tokens > CMC_CATEGORY_LIMIT ||
          cmcData.data.coins.length < cmcData.data.num_tokens
        ) {
          diagnostics.push({
            ...diagnostic,
            responseRowCount: cmcData.data.coins.length,
            errorClass: "invalid-shape",
            errorMessage: `CoinMarketCap category response may be truncated (${cmcData.data.coins.length}/${cmcData.data.num_tokens})`,
            rejectionReasonCounts: { "invalid-shape": 1 },
          });
          return recordFailureAndReturn();
        }
        diagnostic.responseRowCount = cmcData.data.coins.length;
        const cmcBySymbol = new Map<string, CmcFallbackQuote>();
        const cmcBySlug = new Map<string, CmcFallbackQuote>();
        for (const entry of cmcData.data.coins) {
          const price = entry.quote?.USD?.price;
          const observedAt = parseUnixOrIsoTimestampSec(entry.quote?.USD?.last_updated);
          if (
            price != null &&
            price > 0 &&
            isFreshFallbackObservedAt(observedAt, CMC_QUOTE_MAX_AGE_SEC)
          ) {
            const symbol = entry.symbol.toUpperCase();
            if (cmcBySymbol.has(symbol)) {
              console.warn(`[enrich] CMC symbol collision: ${symbol} (existing=$${cmcBySymbol.get(symbol)?.price}, new=$${price})`);
            }
            const quote: CmcFallbackQuote = {
              price,
              observedAt: observedAt!,
              observedAtMode: "upstream",
              symbol,
            };
            if (entry.slug) quote.slug = entry.slug;
            cmcBySymbol.set(symbol, quote);
            if (entry.slug) {
              cmcBySlug.set(entry.slug.toLowerCase(), quote);
            }
          }
        }

        for (const entry of missingAfterPass1b) {
          const symbolKey = entry.asset.symbol.toUpperCase();
          const allowSymbolFallback = UNIQUE_ACTIVE_SYMBOLS.has(symbolKey);
          const slug = entry.asset.cmcSlug;
          const cmcQuote = slug
            ? cmcBySlug.get(slug.toLowerCase()) ?? (allowSymbolFallback ? cmcBySymbol.get(symbolKey) : undefined)
            : allowSymbolFallback
              ? cmcBySymbol.get(symbolKey)
              : undefined;
          if (cmcQuote != null && isReasonablePrice(
            cmcQuote.price,
            entry.asset.pegType as string | undefined,
            fxRates,
            buildPriceReasonablenessOptions(entry.asset),
          )) {
            applyResolvedPrice(
              assets[entry.index],
              cmcQuote.price,
              "coinmarketcap",
              "fallback",
              cmcQuote.observedAt,
              cmcQuote.observedAtMode,
            );
            resolved += 1;
          }
        }
        diagnostic.resolvedCount = resolved;
        diagnostic.success = true;
        diagnostics.push(diagnostic);

        if (db) {
          await markCmcFetchCooldown(db, "success");
          await recordProviderOutcomeSafe({
            db,
            circuitSource: CIRCUIT_SOURCE.CMC_PRICES,
            attempted: 1,
            successful: 1,
          });
        }
      } else {
        diagnostics.push(await applyNonOkProviderDiagnostic(
          diagnostic,
          cmcResult ? responseFromBufferedBody(cmcResult) : null,
        ));
        console.warn(`[enrich] CMC API returned ${cmcResult?.response.status ?? "no response"}`);
        if (cmcResult?.response.status === 429) {
          await markCmcFetchCooldown(db, "429");
        }
        await recordProviderOutcomeSafe({
          db,
          circuitSource: CIRCUIT_SOURCE.CMC_PRICES,
          attempted: 1,
          successful: 0,
        });
      }
    }
  } else if (cmcApiKey && !cmcAllowed) {
    console.warn("[enrich] CoinMarketCap circuit open — skipping pass 2");
  }

  return { resolved, failures: [], diagnostics };
}
