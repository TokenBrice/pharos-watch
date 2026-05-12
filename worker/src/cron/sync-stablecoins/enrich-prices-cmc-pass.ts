import {
  CIRCUIT_SOURCE,
  USER_AGENT,
} from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import {
  getCircuitRecord,
  recordOutcomeSafe,
  shouldAttemptFetch,
} from "../../lib/circuit-breaker";
import { getCache, setCache } from "../../lib/db-cache";
import { CmcCategoryResponseSchema } from "../../lib/schemas";
import {
  endpointLabel,
  readResponseSnippet,
  type PricingProviderAttemptDiagnostic,
} from "../../lib/pricing-provider-diagnostics";
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
  type FallbackPriceQuote,
  isFreshFallbackObservedAt,
  parseUnixOrIsoTimestampSec,
  UNIQUE_ACTIVE_SYMBOLS,
} from "./enrich-prices-pass-common";

const CMC_REQUEST_TIMEOUT_MS = 10_000;
const CMC_MAX_RETRIES = 0;
const CMC_CATEGORY_LIMIT = 300;
const CMC_QUOTE_MAX_AGE_SEC = 60 * 60;
const CMC_PASSTHROUGH_STATUSES = [400, 401, 403, 404, 408, 409, 418, 425, 429, 451, 500, 502, 503, 504];

interface CmcFallbackQuote extends FallbackPriceQuote {
  observedAt: number;
  symbol: string;
  slug?: string;
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

  const missingAfterPass1b = assets
    .map((asset, index) => ({ asset, index }))
    .filter((entry) => hasMissingPrice(entry.asset));
  if (missingAfterPass1b.length === 0) {
    if (db) {
      const record = await getCircuitRecord(db, CIRCUIT_SOURCE.CMC_PRICES);
      if (record.state !== "closed") {
        diagnostics.push({
          source: "coinmarketcap",
          stage: "no-candidates",
          endpoint: "pro-api.coinmarketcap.com/v1/cryptocurrency/category",
          status: null,
          ok: true,
          success: true,
          candidateCount: 0,
        });
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, true);
      }
    }
    return diagnostics.length > 0 ? { resolved, failures: [], diagnostics } : { resolved, failures: [] };
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
      const url = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/category?id=604f2753ebccdd50cd175fc1&limit=300&convert=USD";
      const cmcTimeout = AbortSignal.timeout(CMC_REQUEST_TIMEOUT_MS);
      const cmcSignal = signal ? AbortSignal.any([signal, cmcTimeout]) : cmcTimeout;
      const cmcRes = await fetchWithRetry(
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
        },
      );
      const diagnostic: PricingProviderAttemptDiagnostic = {
        source: "coinmarketcap",
        stage: "fallback",
        endpoint: endpointLabel(url),
        status: cmcRes?.status ?? null,
        ok: cmcRes?.ok === true,
        success: false,
        candidateCount: missingAfterPass1b.length,
      };

      if (cmcRes?.ok) {
        let cmcJson: unknown;
        try {
          cmcJson = await cmcRes.json();
        } catch (error) {
          diagnostics.push({
            ...diagnostic,
            errorClass: "malformed-json",
            errorMessage: error instanceof Error ? error.message : String(error),
            rejectionReasonCounts: { "malformed-json": 1 },
          });
          if (db) {
            await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, false);
          }
          return { resolved, failures: [], diagnostics };
        }
        const parsed = CmcCategoryResponseSchema.safeParse(cmcJson);
        if (!parsed.success) {
          diagnostics.push({
            ...diagnostic,
            errorClass: "invalid-shape",
            errorMessage: "Expected CoinMarketCap category payload with data.num_tokens and quote timestamps",
            rejectionReasonCounts: { "invalid-shape": 1 },
          });
          if (db) {
            await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, false);
          }
          return { resolved, failures: [], diagnostics };
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
          if (db) {
            await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, false);
          }
          return { resolved, failures: [], diagnostics };
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
          try {
            await setCache(db, "cmc_last_fetch", "1");
          } catch (error) {
            console.warn("[enrich-prices] Failed to update CMC rate-limit timestamp:", error);
          }
          await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, true);
        }
      } else {
        diagnostic.snippet = cmcRes ? await readResponseSnippet(cmcRes) : undefined;
        diagnostic.rejectionReasonCounts = { "non-ok": 1 };
        diagnostics.push(diagnostic);
        console.warn(`[enrich] CMC API returned ${cmcRes?.status ?? "no response"}`);
        if (db) {
          await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, false);
        }
      }
    }
  } else if (cmcApiKey && !cmcAllowed) {
    diagnostics.push({
      source: "coinmarketcap",
      stage: "fallback",
      endpoint: "pro-api.coinmarketcap.com/v1/cryptocurrency/category",
      status: null,
      ok: false,
      success: false,
      candidateCount: missingAfterPass1b.length,
      errorClass: "blocked",
      errorMessage: "CoinMarketCap circuit open",
      rejectionReasonCounts: { blocked: 1 },
    });
    console.warn("[enrich] CoinMarketCap circuit open — skipping pass 2");
  }

  return { resolved, failures: [], diagnostics };
}
