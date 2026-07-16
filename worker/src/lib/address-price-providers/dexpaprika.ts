import type { AddressPriceProviderRunResult, AddressPriceTarget } from "./types";
import { throwIfAborted } from "../abort";
import { applyInvalidShapeDiagnostic, buildCapSkipDiagnostic } from "../pricing-provider-lifecycle";
import {
  ADDRESS_PROVIDER_MIN_LIQUIDITY_USD,
  buildSkippedAddressPriceAttempts,
  createProviderRunState,
  fetchProviderJson,
  finalizeAddressPriceDiagnosticAttempts,
  getTokenAddressFromRecord,
  incrementReason,
  isRecord,
  parseNonNegativeNumber,
  parseObservedAt,
  parsePositiveNumber,
} from "./shared";
import {
  readProviderAvailability,
  readProviderNegativeCache,
  recordProviderEnvironmentAvailable,
  suppressProviderUntil,
  writeProviderNegativeCache,
} from "../pricing-provider-runtime-state";

const DEXPAPRIKA_MAX_REQUESTS = 60;
const DEXPAPRIKA_NOT_FOUND_TTL_SEC = 24 * 60 * 60;
const DEXPAPRIKA_RATE_LIMIT_DEFAULT_SEC = 15 * 60;
const DEXPAPRIKA_RATE_LIMIT_MAX_SEC = 60 * 60;

function targetCacheKey(target: AddressPriceTarget): string {
  return `${target.providerChainId}:${target.address.toLowerCase()}`;
}

export async function runDexPaprikaAddressProvider(
  targets: AddressPriceTarget[],
  signal: AbortSignal | undefined,
  deadlineMs: number,
  runtime?: { db?: D1Database; nowSec?: number },
): Promise<AddressPriceProviderRunResult> {
  const state = createProviderRunState();
  const { diagnostics, quotes, rejectedTargets } = state;
  let { successfulRequests, attemptedRequests } = state;
  let rateLimited = false;
  const nowSec = runtime?.nowSec ?? Math.floor(Date.now() / 1000);
  const availability = runtime?.db
    ? await readProviderAvailability(runtime.db, "dexpaprika-address", nowSec)
    : { shouldFetch: true, probeOnly: false, blockedStatus: null, nextProbeAt: null };
  if (!availability.shouldFetch) {
    return {
      quotes,
      diagnostics: [{
        source: "dexpaprika-address",
        stage: "health-probe",
        endpoint: "dexpaprika-address:rate-limit",
        status: availability.blockedStatus,
        ok: false,
        success: false,
        candidateCount: targets.length,
        errorClass: "rate-limited",
        errorMessage: `Provider probe deferred until ${availability.nextProbeAt ?? "unknown"}`,
        rejectionReasonCounts: { blocked: targets.length },
        assetAttempts: buildSkippedAddressPriceAttempts(
          "dexpaprika-address",
          targets,
          "provider-suppressed",
          "rate-limited",
        ),
      }],
      rejectedTargets: { blocked: targets.length },
      successfulRequests: 0,
      attemptedRequests: 0,
    };
  }

  const negativeCache = await readProviderNegativeCache(runtime?.db, "dexpaprika-address", nowSec);
  const activeTargets = targets.filter((target) => !negativeCache.has(targetCacheKey(target)));
  const cachedTargets = targets.length - activeTargets.length;
  const requestLimit = availability.probeOnly ? 1 : DEXPAPRIKA_MAX_REQUESTS;
  const processedTargets = new Set<AddressPriceTarget>();
  if (cachedTargets > 0) {
    const negativeCachedTargets = targets.filter((target) => negativeCache.has(targetCacheKey(target)));
    rejectedTargets.blocked = cachedTargets;
    diagnostics.push({
      source: "dexpaprika-address",
      stage: "primary",
      endpoint: "dexpaprika-address:negative-cache",
      status: 404,
      ok: false,
      success: false,
      candidateCount: cachedTargets,
      errorClass: "negative-cache",
      rejectionReasonCounts: { blocked: cachedTargets },
      assetAttempts: buildSkippedAddressPriceAttempts(
        "dexpaprika-address",
        negativeCachedTargets,
        "negative-cache",
        "negative-cache",
      ),
    });
  }

  for (const target of activeTargets.slice(0, requestLimit)) {
    throwIfAborted(signal);
    if (Date.now() >= deadlineMs) break;
    if (negativeCache.has(targetCacheKey(target))) continue;
    processedTargets.add(target);
    attemptedRequests += 1;
    const url = `https://api.dexpaprika.com/networks/${target.providerChainId}/tokens/${target.address}`;
    const { json, diagnostic: rawDiagnostic } = await fetchProviderJson({
      provider: "dexpaprika-address",
      url,
      candidateCount: 1,
      targets: [target],
      signal,
    });
    let diagnostic = rawDiagnostic;
    if (isRecord(json)) {
      const matchedCountBefore = quotes.length;
      const responseAddress = getTokenAddressFromRecord(json);
      if (responseAddress && responseAddress.toLowerCase() !== target.address.toLowerCase()) {
        incrementReason(rejectedTargets, "invalid-shape");
      } else {
        const summary = isRecord(json.summary) ? json.summary : {};
        const priceUsd = parsePositiveNumber(summary.price_usd ?? json.price_usd);
        const liquidityUsd = parseNonNegativeNumber(summary.liquidity_usd);
        const pools = parseNonNegativeNumber(summary.pools);
        const day = isRecord(summary["24h"]) ? summary["24h"] : {};
        const volume24hUsd = isRecord(day) ? parseNonNegativeNumber(day.volume_usd) ?? undefined : undefined;
        if (!priceUsd) {
          incrementReason(rejectedTargets, "missing-quote");
        } else if (liquidityUsd != null && liquidityUsd < ADDRESS_PROVIDER_MIN_LIQUIDITY_USD) {
          incrementReason(rejectedTargets, "price-rejected");
        } else {
          quotes.push({
            stablecoinId: target.stablecoinId,
            source: "dexpaprika-address",
            chain: target.chain,
            address: target.address,
            priceUsd,
            observedAt: parseObservedAt(json.last_updated),
            observedAtMode: "upstream",
            ...(liquidityUsd != null ? { liquidityUsd } : {}),
            ...(volume24hUsd != null ? { volume24hUsd } : {}),
            ...(pools != null ? { poolCount: pools } : {}),
            metadata: { providerChainId: target.providerChainId },
          });
        }
      }
      diagnostic.responseRowCount = 1;
      diagnostic.matchedCount = quotes.length - matchedCountBefore;
      diagnostic.success = true;
      successfulRequests += 1;
    } else if (json != null) {
      diagnostic = applyInvalidShapeDiagnostic(diagnostic, "Expected DexPaprika token detail object");
    }
    diagnostics.push(finalizeAddressPriceDiagnosticAttempts(diagnostic, quotes));
    if (diagnostic.status === 404) {
      // A deterministic token miss still proves that the provider is reachable.
      successfulRequests += 1;
      negativeCache.add(targetCacheKey(target));
      await writeProviderNegativeCache(
        runtime?.db,
        "dexpaprika-address",
        targetCacheKey(target),
        404,
        nowSec,
        DEXPAPRIKA_NOT_FOUND_TTL_SEC,
      );
    }
    if (diagnostic.status === 429) {
      rateLimited = true;
      const retryAfterSec = Math.min(
        DEXPAPRIKA_RATE_LIMIT_MAX_SEC,
        Math.max(1, diagnostic.retryAfterSec ?? DEXPAPRIKA_RATE_LIMIT_DEFAULT_SEC),
      );
      if (runtime?.db) {
        await suppressProviderUntil(
          runtime.db,
          "dexpaprika-address",
          429,
          nowSec,
          nowSec + retryAfterSec,
        );
      }
      break;
    }
  }

  if (successfulRequests > 0 && !rateLimited && runtime?.db) {
    await recordProviderEnvironmentAvailable(runtime.db, "dexpaprika-address", nowSec);
  }

  const skippedTargets = activeTargets.filter((target) => !processedTargets.has(target));
  if (skippedTargets.length > 0) {
    const diagnostic = buildCapSkipDiagnostic({ source: "dexpaprika-address", label: "DexPaprika" }, skippedTargets.length);
    const deadlineReached = Date.now() >= deadlineMs;
    diagnostic.assetAttempts = buildSkippedAddressPriceAttempts(
      "dexpaprika-address",
      skippedTargets,
      deadlineReached ? "deadline" : rateLimited ? "budget" : "request-cap",
      deadlineReached ? "timeout" : rateLimited ? "rate-limited" : "cap",
    );
    diagnostics.push(diagnostic);
  }

  return {
    quotes,
    diagnostics,
    rejectedTargets,
    successfulRequests,
    attemptedRequests,
  };
}
