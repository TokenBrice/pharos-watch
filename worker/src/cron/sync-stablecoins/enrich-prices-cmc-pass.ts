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
  createPricingAssetAttempt,
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
const CMC_VERIFIED_QUOTES_CACHE_KEY = "cmc_verified_targeted_quotes:v1";
const CMC_TARGETED_MAX_SLUGS = 25;
const CMC_VERIFIED_QUOTES_MAX_ENTRIES = 100;

interface CmcFallbackQuote extends FallbackPriceQuote {
  observedAt: number;
  symbol: string;
  slug?: string;
}

export interface CmcTargetedCandidate {
  asset: PeggedAsset;
  index: number;
}

interface CmcVerifiedTargetedQuote {
  assetId: string;
  slug: string;
  symbol: string;
  price: number;
  volume24h: number;
  observedAt: number;
  providerAddress: string | null;
  chain: string | null;
  active: true;
}

export function selectRotatedCmcCandidates(
  candidates: readonly CmcTargetedCandidate[],
  nowSec = Math.floor(Date.now() / 1_000),
): CmcTargetedCandidate[] {
  if (candidates.length <= CMC_TARGETED_MAX_SLUGS) return [...candidates];
  const start = (Math.floor(nowSec / CMC_FETCH_COOLDOWN_SEC) * CMC_TARGETED_MAX_SLUGS) % candidates.length;
  return Array.from(
    { length: CMC_TARGETED_MAX_SLUGS },
    (_, offset) => candidates[(start + offset) % candidates.length]!,
  );
}

function buildSkippedCmcAttempts(
  candidates: readonly CmcTargetedCandidate[],
  skipReason: "circuit-open" | "provider-suppressed" | "request-cap",
  rejectionClass: string,
): NonNullable<PricingProviderAttemptDiagnostic["assetAttempts"]> {
  return candidates.slice(0, 100).map((candidate) => createPricingAssetAttempt({
    assetId: candidate.asset.id,
    adapter: "coinmarketcap",
    target: `slug:${candidate.asset.cmcSlug}`,
    state: "skipped",
    skipReason,
    rejectionClass,
    candidateAt: Math.floor(Date.now() / 1000),
  }));
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

function parseVerifiedCmcQuote(value: unknown): CmcVerifiedTargetedQuote | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.assetId !== "string" || entry.assetId.length > 160 ||
    typeof entry.slug !== "string" || entry.slug.length > 160 ||
    typeof entry.symbol !== "string" || entry.symbol.length > 40 ||
    typeof entry.price !== "number" || !Number.isFinite(entry.price) || entry.price <= 0 ||
    typeof entry.volume24h !== "number" || !Number.isFinite(entry.volume24h) || entry.volume24h <= 0 ||
    typeof entry.observedAt !== "number" || !Number.isFinite(entry.observedAt) || entry.observedAt <= 0 ||
    entry.active !== true ||
    !(entry.providerAddress == null || typeof entry.providerAddress === "string") ||
    !(entry.chain == null || typeof entry.chain === "string")
  ) return null;
  return {
    assetId: entry.assetId,
    slug: entry.slug,
    symbol: entry.symbol,
    price: entry.price,
    volume24h: entry.volume24h,
    observedAt: Math.floor(entry.observedAt),
    providerAddress: normalizedContractAddress(entry.providerAddress as string | null),
    chain: typeof entry.chain === "string" ? entry.chain.slice(0, 80) : null,
    active: true,
  };
}

async function loadVerifiedCmcQuotes(db: D1Database | undefined): Promise<CmcVerifiedTargetedQuote[]> {
  if (!db) return [];
  try {
    const row = await getCache(db, CMC_VERIFIED_QUOTES_CACHE_KEY);
    if (!row) return [];
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, CMC_VERIFIED_QUOTES_MAX_ENTRIES)
      .map(parseVerifiedCmcQuote)
      .filter((entry): entry is CmcVerifiedTargetedQuote => entry != null);
  } catch (error) {
    console.warn("[enrich-prices] Failed to load verified CMC targeted quotes:", error);
    return [];
  }
}

function replayVerifiedCmcQuotes(params: {
  assets: PeggedAsset[];
  candidates: readonly CmcTargetedCandidate[];
  cachedQuotes: readonly CmcVerifiedTargetedQuote[];
  fxRates: Record<string, number> | undefined;
}): { resolved: number; diagnostic: PricingProviderAttemptDiagnostic | null } {
  if (params.candidates.length === 0 || params.cachedQuotes.length === 0) {
    return { resolved: 0, diagnostic: null };
  }
  const cachedByAssetId = new Map(params.cachedQuotes.map((quote) => [quote.assetId, quote] as const));
  const attempts: NonNullable<PricingProviderAttemptDiagnostic["assetAttempts"]> = [];
  let resolved = 0;
  for (const candidate of params.candidates) {
    const cached = cachedByAssetId.get(candidate.asset.id);
    if (!cached) continue;
    const hasConfiguredContracts = (candidate.asset.contracts?.length ?? 0) > 0;
    const providerAddressMatches = !hasConfiguredContracts || (
      cached.providerAddress != null && matchesConfiguredContract(candidate.asset, cached.providerAddress)
    );
    const accepted =
      cached.slug === candidate.asset.cmcSlug?.toLowerCase() &&
      cached.symbol === candidate.asset.symbol.toUpperCase() &&
      cached.active &&
      providerAddressMatches &&
      isFreshFallbackObservedAt(cached.observedAt, CMC_QUOTE_MAX_AGE_SEC) &&
      isReasonablePrice(
        cached.price,
        candidate.asset.pegType as string | undefined,
        params.fxRates,
        buildPriceReasonablenessOptions(candidate.asset),
      );
    attempts.push(createPricingAssetAttempt({
      assetId: candidate.asset.id,
      adapter: "coinmarketcap-verified-cache",
      source: "coinmarketcap",
      ...(accepted && cached.chain && cached.providerAddress
        ? { chain: cached.chain, target: cached.providerAddress }
        : { target: `slug:${candidate.asset.cmcSlug}` }),
      state: "attempted",
      result: accepted ? "resolved" : "rejected",
      ...(!accepted ? { rejectionClass: "cached-quote-rejected" } : {}),
      candidateAt: Math.floor(Date.now() / 1_000),
      observedAt: cached.observedAt,
      replaySafe: true,
    }));
    if (!accepted) continue;
    applyResolvedPrice(
      params.assets[candidate.index],
      cached.price,
      "coinmarketcap",
      "fallback",
      cached.observedAt,
      "upstream",
    );
    resolved += 1;
  }
  return {
    resolved,
    diagnostic: buildPricingProviderDiagnostic({
      source: "coinmarketcap",
      stage: "fallback",
      endpoint: "coinmarketcap:verified-targeted-cache",
      candidateCount: attempts.length,
    }, {
      ok: true,
      success: true,
      responseRowCount: params.cachedQuotes.length,
      resolvedCount: resolved,
      assetAttempts: attempts,
    }),
  };
}

async function persistVerifiedCmcQuotes(
  db: D1Database | undefined,
  previous: readonly CmcVerifiedTargetedQuote[],
  accepted: readonly CmcVerifiedTargetedQuote[],
): Promise<void> {
  if (!db || accepted.length === 0) return;
  const merged = new Map<string, CmcVerifiedTargetedQuote>();
  for (const quote of [...previous, ...accepted]) {
    if (isFreshFallbackObservedAt(quote.observedAt, CMC_QUOTE_MAX_AGE_SEC)) {
      merged.set(quote.assetId, quote);
    }
  }
  try {
    await setCache(
      db,
      CMC_VERIFIED_QUOTES_CACHE_KEY,
      JSON.stringify([...merged.values()].slice(-CMC_VERIFIED_QUOTES_MAX_ENTRIES)),
    );
  } catch (error) {
    console.warn("[enrich-prices] Failed to persist verified CMC targeted quotes:", error);
  }
}

async function fetchTargetedCmcQuotes(params: {
  assets: PeggedAsset[];
  candidates: CmcTargetedCandidate[];
  cmcApiKey: string;
  fxRates: Record<string, number> | undefined;
  signal?: AbortSignal;
}): Promise<{
  resolved: number;
  acceptedQuotes: CmcVerifiedTargetedQuote[];
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
    assetAttempts: params.candidates.slice(0, 100).map((candidate) => (
      createPricingAssetAttempt({
        assetId: candidate.asset.id,
        adapter: "coinmarketcap",
        target: `slug:${candidate.asset.cmcSlug}`,
        state: "attempted",
        result: "unresolved",
        candidateAt: Math.floor(Date.now() / 1000),
      })
    )),
  });
  const updateAttempt = (
    assetId: string,
    result: "resolved" | "rejected",
    rejectionClass?: string,
    observedAt?: number | null,
    identity?: { chain: string; target: string },
  ): void => {
    diagnostic.assetAttempts = diagnostic.assetAttempts?.map((attempt) => (
      attempt.assetId === assetId
        ? {
            ...attempt,
            result,
            ...(rejectionClass ? { rejectionClass } : {}),
            ...(observedAt !== undefined ? { observedAt } : {}),
            ...(identity ?? {}),
          }
        : attempt
    ));
  };
  const failAllAttempts = (value: PricingProviderAttemptDiagnostic): PricingProviderAttemptDiagnostic => ({
    ...value,
    assetAttempts: value.assetAttempts?.map((attempt) => ({
      ...attempt,
      result: "failed",
      rejectionClass: value.errorClass ?? Object.keys(value.rejectionReasonCounts ?? {})[0] ?? "upstream-error",
    })),
  });
  if (!result?.response.ok) {
    const nonOkDiagnostic = await applyNonOkProviderDiagnostic(
      diagnostic,
      result ? responseFromBufferedBody(result) : null,
    );
    return {
      resolved: 0,
      acceptedQuotes: [],
      diagnostic: failAllAttempts(nonOkDiagnostic),
      rateLimited: result?.response.status === 429,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(result.body);
  } catch (error) {
    return {
      resolved: 0,
      acceptedQuotes: [],
      diagnostic: failAllAttempts(applyJsonParseFailureDiagnostic(diagnostic, error)),
      rateLimited: false,
    };
  }
  const parsed = CmcLatestQuotesResponseSchema.safeParse(json);
  if (!parsed.success) {
    return {
      resolved: 0,
      acceptedQuotes: [],
      diagnostic: failAllAttempts({
        ...diagnostic,
        errorClass: "invalid-shape",
        errorMessage: "Expected CoinMarketCap v3 latest-quotes payload",
        rejectionReasonCounts: { "invalid-shape": 1 },
      }),
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
  const acceptedQuotes: CmcVerifiedTargetedQuote[] = [];
  for (const candidate of params.candidates) {
    const expectedSlug = candidate.asset.cmcSlug!.toLowerCase();
    const quote = quotesBySlug.get(expectedSlug);
    if (!quote) {
      reject("missing-quote");
      updateAttempt(candidate.asset.id, "rejected", "missing-quote");
      continue;
    }
    const providerAddress = normalizedContractAddress(quote.platform?.token_address);
    const requiresContractIdentity = (candidate.asset.contracts?.length ?? 0) > 0;
    if (
      quote.slug.toLowerCase() !== expectedSlug ||
      quote.symbol.toUpperCase() !== candidate.asset.symbol.toUpperCase() ||
      quote.is_active !== 1 ||
      (requiresContractIdentity && (
        providerAddress == null || !matchesConfiguredContract(candidate.asset, providerAddress)
      ))
    ) {
      reject("unsupported-quote");
      updateAttempt(candidate.asset.id, "rejected", "unsupported-quote");
      continue;
    }
    matched += 1;
    const matchedDeployment = providerAddress == null
      ? null
      : candidate.asset.contracts?.find(
          (deployment) => normalizedContractAddress(deployment.address) === providerAddress,
        ) ?? null;
    const providerIdentity = matchedDeployment && providerAddress
      ? { chain: matchedDeployment.chain, target: providerAddress }
      : undefined;
    const usdQuote = Array.isArray(quote.quote)
      ? quote.quote.find((entry) => entry.symbol.toUpperCase() === "USD")
      : quote.quote.USD;
    const price = usdQuote?.price;
    const volume24h = usdQuote?.volume_24h;
    const observedAt = parseUnixOrIsoTimestampSec(usdQuote?.last_updated);
    if (!isFreshFallbackObservedAt(observedAt, CMC_QUOTE_MAX_AGE_SEC)) {
      reject("stale");
      updateAttempt(candidate.asset.id, "rejected", "stale", observedAt, providerIdentity);
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
      updateAttempt(candidate.asset.id, "rejected", "price-rejected", observedAt, providerIdentity);
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
    acceptedQuotes.push({
      assetId: candidate.asset.id,
      slug: expectedSlug,
      symbol: candidate.asset.symbol.toUpperCase(),
      price,
      volume24h,
      observedAt: observedAt!,
      providerAddress,
      chain: matchedDeployment?.chain ?? null,
      active: true,
    });
    updateAttempt(candidate.asset.id, "resolved", undefined, observedAt, providerIdentity);
  }

  return {
    resolved,
    acceptedQuotes,
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

  const replayCandidates = collectMissingPriceCandidates(assets)
    .filter((entry) => entry.asset.cmcSlug != null);
  const cachedVerifiedQuotes = await loadVerifiedCmcQuotes(db);
  const replay = replayVerifiedCmcQuotes({
    assets,
    candidates: replayCandidates,
    cachedQuotes: cachedVerifiedQuotes,
    fxRates,
  });
  resolved += replay.resolved;
  if (replay.diagnostic) diagnostics.push(replay.diagnostic);

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

        let categoryResolved = 0;
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
            categoryResolved += 1;
          }
        }
        let providerAttempts = 1;
        let providerSuccesses = 1;
        diagnostic.resolvedCount = categoryResolved;
        diagnostic.success = true;
        if (categoryTruncated) {
          diagnostic.errorClass = "truncated-response";
          diagnostic.errorMessage =
            `CoinMarketCap category response has an unseen tail (${cmcData.data.coins.length}/${cmcData.data.num_tokens}); usable returned rows were retained`;
        }
        diagnostics.push(diagnostic);

        const allTargetedCandidates = collectMissingPriceCandidates(assets)
          .filter((entry) => entry.asset.cmcSlug != null);
        const targetedCandidates = selectRotatedCmcCandidates(allTargetedCandidates);
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
          await persistVerifiedCmcQuotes(db, cachedVerifiedQuotes, targeted.acceptedQuotes);
          diagnostics.push(targeted.diagnostic);
          if (targeted.diagnostic.success) providerSuccesses += 1;
          if (targeted.rateLimited) await markCmcFetchCooldown(db, "targeted 429");
        }
        const targetedIds = new Set(targetedCandidates.map((candidate) => candidate.asset.id));
        const cappedTargetedCandidates = allTargetedCandidates.filter(
          (candidate) => !targetedIds.has(candidate.asset.id),
        );
        if (cappedTargetedCandidates.length > 0) {
          diagnostics.push(buildPricingProviderDiagnostic({
            source: "coinmarketcap",
            stage: "fallback",
            endpoint: `${CMC_QUOTES_ENDPOINT}:request-cap`,
            candidateCount: cappedTargetedCandidates.length,
          }, {
            ok: true,
            success: true,
            errorClass: "cap",
            errorMessage: `Skipped ${cappedTargetedCandidates.length} targeted CMC slugs after request cap`,
            assetAttempts: buildSkippedCmcAttempts(cappedTargetedCandidates, "request-cap", "cap"),
          }));
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
    } else {
      const cooldownCandidates = missingAfterPass1b.filter((entry) => entry.asset.cmcSlug != null);
      if (cooldownCandidates.length > 0) {
        diagnostics.push(buildPricingProviderDiagnostic({
          source: "coinmarketcap",
          stage: "fallback",
          endpoint: `${CMC_QUOTES_ENDPOINT}:cooldown`,
          candidateCount: cooldownCandidates.length,
        }, {
          ok: true,
          success: true,
          errorClass: "cooldown",
          errorMessage: "CoinMarketCap fetch cooldown active",
          assetAttempts: buildSkippedCmcAttempts(cooldownCandidates, "provider-suppressed", "cooldown"),
        }));
      }
    }
  } else if (cmcApiKey && !cmcAllowed) {
    const blockedDiagnostic = diagnostics[diagnostics.length - 1];
    const blockedCandidates = missingAfterPass1b.filter((entry) => entry.asset.cmcSlug != null);
    if (blockedDiagnostic && blockedCandidates.length > 0) {
      blockedDiagnostic.assetAttempts = buildSkippedCmcAttempts(blockedCandidates, "circuit-open", "blocked");
    }
    console.warn("[enrich] CoinMarketCap circuit open — skipping pass 2");
  }

  return { resolved, failures: [], diagnostics };
}
