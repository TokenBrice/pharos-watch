import type { AddressPriceProviderRunResult, AddressPriceQuote, AddressPriceTarget } from "./types";
import { throwIfAborted } from "../abort";
import { applyInvalidShapeDiagnostic, buildCapSkipDiagnostic } from "../pricing-provider-lifecycle";
import {
  ADDRESS_PROVIDER_MIN_LIQUIDITY_USD,
  fetchProviderJson,
  getTokenAddressFromRecord,
  incrementReason,
  isRecord,
  parseNonNegativeNumber,
  parseObservedAt,
  parsePositiveNumber,
} from "./shared";

const DEXPAPRIKA_MAX_REQUESTS = 60;

export async function runDexPaprikaAddressProvider(
  targets: AddressPriceTarget[],
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<AddressPriceProviderRunResult> {
  const diagnostics: AddressPriceProviderRunResult["diagnostics"] = [];
  const quotes: AddressPriceQuote[] = [];
  const rejectedTargets: AddressPriceProviderRunResult["rejectedTargets"] = {};
  let successfulRequests = 0;
  let attemptedRequests = 0;
  const cappedTargets = Math.max(0, targets.length - DEXPAPRIKA_MAX_REQUESTS);

  for (const target of targets.slice(0, DEXPAPRIKA_MAX_REQUESTS)) {
    throwIfAborted(signal);
    if (Date.now() >= deadlineMs) break;
    attemptedRequests += 1;
    const url = `https://api.dexpaprika.com/networks/${target.providerChainId}/tokens/${target.address}`;
    const { json, diagnostic: rawDiagnostic } = await fetchProviderJson({
      provider: "dexpaprika-address",
      url,
      candidateCount: 1,
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
    diagnostics.push(diagnostic);
  }

  if (cappedTargets > 0) {
    diagnostics.push(buildCapSkipDiagnostic({ source: "dexpaprika-address", label: "DexPaprika" }, cappedTargets));
  }

  return {
    quotes,
    diagnostics,
    attemptedTargets: Math.min(targets.length, DEXPAPRIKA_MAX_REQUESTS),
    matchedTargets: quotes.length,
    rejectedTargets,
    successfulRequests,
    attemptedRequests,
  };
}
