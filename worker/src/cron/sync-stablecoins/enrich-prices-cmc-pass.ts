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
import { CmcCategoryResponseSchema, CmcLatestQuotesResponseSchema } from "../../lib/schemas";
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
const CMC_QUOTES_ENDPOINT = "pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest";
const CMC_STABLECOIN_CATEGORY_ID = "604f2753ebccdd50cd175fc1";
const CMC_LAST_FETCH_CACHE_KEY = "cmc_last_fetch";
const CMC_TARGETED_MAX_SLUGS = 25;

interface CmcFallbackQuote extends FallbackPriceQuote {
  observedAt: number;
  symbol: string;
  slug?: string;
}

interface CmcTargetedCandidate {
  asset: PeggedAsset;
  index: number;
}

function normalizedContractAddress(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function matchesConfiguredContract(asset: PeggedAsset, providerAddress: string): boolean {
  const normalized = normalizedContractAddress(providerAddress);
  return normalized != null && (asset.contracts ?? []).some(
    (deployment) => normalizedContractAddress(deployment.address) === normalized,
  );
}

async function fetchTargetedCmcQuotes(params: {
  assets: PeggedAsset[];
  candidates: CmcTargetedCandidate[];
  cmcApiKey: string;
  fxRates: Record<string, number> | undefined;
  signal?: AbortSignal;
}): Promise<{
  resolved: number;
  diagnostic: PricingProviderAttemptDiagnostic;
  rateLimited: boolean;
}> {
  const slugs = params.candidates.map((entry) => entry.asset.cmcSlug!.toLowerCase());
  const url = `https://${CMC_QUOTES_ENDPOINT}?slug=${encodeURIComponent(slugs.join(","))}&convert=USD`;
  const timeout = AbortSignal.timeout(CMC_REQUEST_TIMEOUT_MS);
  const requestSignal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  const result = await fetchTextWithRetry(
    url,
    {
      headers: {
        "X-CMC_PRO_API_KEY": params.cmcApiKey,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: requestSignal,
    },
    CMC_MAX_RETRIES,
    {
      timeoutMs: CMC_REQUEST_TIMEOUT_MS,
      passthroughStatuses: CMC_PASSTHROUGH_STATUSES,
      returnFinalResponse: true,
    },
  );
  const diagnostic = buildPricingProviderDiagnostic({
    source: "coinmarketcap",
    stage: "fallback",
    endpoint: endpointLabel(url),
    candidateCount: params.candidates.length,
  }, {
    status: result?.response.status ?? null,
    ok: result?.response.ok === true,
  });
  if (!result?.response.ok) {
    return {
      resolved: 0,
      diagnostic: await applyNonOkProviderDiagnostic(
        diagnostic,
        result ? responseFromBufferedBody(result) : null,
      ),
      rateLimited: result?.response.status === 429,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(result.body);
  } catch (error) {
    return { resolved: 0, diagnostic: applyJsonParseFailureDiagnostic(diagnostic, error), rateLimited: false };
  }
  const parsed = CmcLatestQuotesResponseSchema.safeParse(json);
  if (!parsed.success) {
    return {
      resolved: 0,
      diagnostic: {
        ...diagnostic,
        errorClass: "invalid-shape",
        errorMessage: "Expected CoinMarketCap v3 latest-quotes payload",
        rejectionReasonCounts: { "invalid-shape": 1 },
      },
      rateLimited: false,
    };
  }

  const quotesBySlug = new Map(parsed.data.data.map((entry) => [entry.slug.toLowerCase(), entry]));
  const rejections: NonNullable<PricingProviderAttemptDiagnostic["rejectionReasonCounts"]> = {};
  const reject = (reason: keyof typeof rejections): void => {
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  };
  let resolved = 0;
  let matched = 0;
  for (const candidate of params.candidates) {
    const expectedSlug = candidate.asset.cmcSlug!.toLowerCase();
    const quote = quotesBySlug.get(expectedSlug);
    if (!quote) {
      reject("missing-quote");
      continue;
    }
    const providerAddress = normalizedContractAddress(quote.platform?.token_address);
    if (
      quote.slug.toLowerCase() !== expectedSlug ||
      quote.symbol.toUpperCase() !== candidate.asset.symbol.toUpperCase() ||
      quote.is_active === 0 ||
      (providerAddress != null && !matchesConfiguredContract(candidate.asset, providerAddress))
    ) {
      reject("unsupported-quote");
      continue;
    }
    matched += 1;
    const usdQuote = Array.isArray(quote.quote)
      ? quote.quote.find((entry) => entry.symbol.toUpperCase() === "USD")
      : quote.quote.USD;
    const price = usdQuote?.price;
    const volume24h = usdQuote?.volume_24h;
    const observedAt = parseUnixOrIsoTimestampSec(usdQuote?.last_updated);
    if (!isFreshFallbackObservedAt(observedAt, CMC_QUOTE_MAX_AGE_SEC)) {
      reject("stale");
      continue;
    }
    if (
      price == null || price <= 0 || volume24h == null || !Number.isFinite(volume24h) || volume24h <= 0 ||
      !isReasonablePrice(
        price,
        candidate.asset.pegType as string | undefined,
        params.fxRates,
        buildPriceReasonablenessOptions(candidate.asset),
      )
    ) {
      reject("price-rejected");
      continue;
    }
    applyResolvedPrice(
      params.assets[candidate.index],
      price,
      "coinmarketcap",
      "fallback",
      observedAt!,
      "upstream",
    );
    resolved += 1;
  }

  return {
    resolved,
    diagnostic: {
      ...diagnostic,
      success: true,
      responseRowCount: quotesBySlug.size,
      matchedCount: matched,
      resolvedCount: resolved,
      ...(Object.keys(rejections).length > 0 ? { rejectionReasonCounts: rejections } : {}),
    },
    rateLimited: false,
  };
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
        const categoryTruncated =
          cmcData.data.num_tokens > CMC_CATEGORY_LIMIT ||
          cmcData.data.coins.length < cmcData.data.num_tokens;
        if (categoryTruncated) {
          diagnostics.push({
            ...diagnostic,
            responseRowCount: cmcData.data.coins.length,
            errorClass: "invalid-shape",
            errorMessage: `CoinMarketCap category response may be truncated (${cmcData.data.coins.length}/${cmcData.data.num_tokens})`,
            rejectionReasonCounts: { "invalid-shape": 1 },
          });
        }
        diagnostic.responseRowCount = cmcData.data.coins.length;
        const cmcBySymbol = new Map<string, CmcFallbackQuote>();
        const cmcBySlug = new Map<string, CmcFallbackQuote>();
        for (const entry of categoryTruncated ? [] : cmcData.data.coins) {
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
        let providerAttempts = 1;
        let providerSuccesses = 0;
        if (!categoryTruncated) {
          diagnostic.resolvedCount = resolved;
          diagnostic.success = true;
          diagnostics.push(diagnostic);
          providerSuccesses += 1;
        }

        const targetedCandidates = collectMissingPriceCandidates(assets)
          .filter((entry) => entry.asset.cmcSlug != null)
          .slice(0, CMC_TARGETED_MAX_SLUGS);
        if (targetedCandidates.length > 0) {
          providerAttempts += 1;
          const targeted = await fetchTargetedCmcQuotes({
            assets,
            candidates: targetedCandidates,
            cmcApiKey,
            fxRates,
            signal,
          });
          resolved += targeted.resolved;
          diagnostics.push(targeted.diagnostic);
          if (targeted.diagnostic.success) providerSuccesses += 1;
          if (targeted.rateLimited) await markCmcFetchCooldown(db, "targeted 429");
        }

        if (providerSuccesses > 0) {
          await markCmcFetchCooldown(db, "success");
        }
        await recordProviderOutcomeSafe({
          db,
          circuitSource: CIRCUIT_SOURCE.CMC_PRICES,
          attempted: providerAttempts,
          successful: providerSuccesses,
        });
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
