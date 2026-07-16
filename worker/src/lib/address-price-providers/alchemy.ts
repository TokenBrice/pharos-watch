import type {
  AddressPriceProviderRuntimeConfig,
  AddressPriceProviderRunResult,
  AddressPriceTarget,
} from "./types";
import { throwIfAborted } from "../abort";
import { applyInvalidShapeDiagnostic, buildCapSkipDiagnostic } from "../pricing-provider-lifecycle";
import {
  chunk,
  buildSkippedAddressPriceAttempts,
  createProviderRunState,
  emptyProviderResult,
  fetchProviderJson,
  finalizeAddressPriceDiagnosticAttempts,
  groupTargetsByProviderChain,
  incrementReason,
  isRecord,
  parseObservedAt,
  parsePositiveNumber,
} from "./shared";

const ALCHEMY_ADDRESS_MAX_REQUESTS = 20;

function buildAlchemyBatches(targets: AddressPriceTarget[]): AddressPriceTarget[][] {
  const groups = [...groupTargetsByProviderChain(targets).values()];
  const batches: AddressPriceTarget[][] = [];
  for (const group of groups) {
    batches.push(...chunk(group, 25));
  }
  return batches;
}

export async function runAlchemyAddressProvider(
  targets: AddressPriceTarget[],
  config: AddressPriceProviderRuntimeConfig,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<AddressPriceProviderRunResult> {
  const apiKey = config.alchemyApiKey?.trim();
  if (!apiKey) return emptyProviderResult("alchemy-address", targets, "missing-provider");
  const state = createProviderRunState();
  const { diagnostics, quotes, rejectedTargets } = state;
  let { successfulRequests, attemptedRequests } = state;
  const batches = buildAlchemyBatches(targets);
  const requestBatches = batches.slice(0, ALCHEMY_ADDRESS_MAX_REQUESTS);
  const processedTargets = new Set<AddressPriceTarget>();

  for (const batch of requestBatches) {
    throwIfAborted(signal);
    if (Date.now() >= deadlineMs) break;
    attemptedRequests += 1;
    const url = `https://api.g.alchemy.com/prices/v1/${encodeURIComponent(apiKey)}/tokens/by-address`;
    const { json, diagnostic: rawDiagnostic } = await fetchProviderJson({
      provider: "alchemy-address",
      url,
      endpoint: "api.g.alchemy.com/prices/v1/<api-key>/tokens/by-address",
      fetchLogUrl: "https://api.g.alchemy.com/prices/v1/<api-key>/tokens/by-address",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addresses: batch.map((target) => ({
            network: target.providerChainId,
            address: target.address,
          })),
        }),
      },
      candidateCount: batch.length,
      targets: batch,
      signal,
    });
    let diagnostic = rawDiagnostic;
    const rows = isRecord(json) && Array.isArray(json.data) ? json.data : null;
    if (rows) {
      const matchedCountBefore = quotes.length;
      const targetByKey = new Map(batch.map((target) => [`${target.providerChainId}:${target.address.toLowerCase()}`, target]));
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const network = typeof row.network === "string" ? row.network : "";
        const address = typeof row.address === "string" ? row.address.toLowerCase() : "";
        const target = targetByKey.get(`${network}:${address}`);
        if (!target) continue;
        const prices = Array.isArray(row.prices) ? row.prices : [];
        const usd = prices.find((price) => isRecord(price) && String(price.currency).toUpperCase() === "USD");
        const priceUsd = isRecord(usd) ? parsePositiveNumber(usd.value) : null;
        if (!priceUsd) {
          incrementReason(rejectedTargets, "missing-quote");
          continue;
        }
        quotes.push({
          stablecoinId: target.stablecoinId,
          source: "alchemy-address",
          chain: target.chain,
          address: target.address,
          priceUsd,
          observedAt: isRecord(usd) ? parseObservedAt(usd.lastUpdatedAt) : null,
          observedAtMode: "upstream",
          metadata: { providerChainId: target.providerChainId },
        });
      }
      diagnostic.responseRowCount = rows.length;
      diagnostic.matchedCount = quotes.length - matchedCountBefore;
      diagnostic.success = true;
      successfulRequests += 1;
    } else if (json != null) {
      diagnostic = applyInvalidShapeDiagnostic(diagnostic, "Expected Alchemy prices data array");
    }
    for (const target of batch) processedTargets.add(target);
    diagnostics.push(finalizeAddressPriceDiagnosticAttempts(diagnostic, quotes));
  }

  const skippedTargets = targets.filter((target) => !processedTargets.has(target));
  if (skippedTargets.length > 0) {
    const diagnostic = buildCapSkipDiagnostic({ source: "alchemy-address", label: "Alchemy" }, skippedTargets.length);
    const deadlineReached = Date.now() >= deadlineMs;
    diagnostic.assetAttempts = buildSkippedAddressPriceAttempts(
      "alchemy-address",
      skippedTargets,
      deadlineReached ? "deadline" : "request-cap",
      deadlineReached ? "timeout" : "cap",
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
