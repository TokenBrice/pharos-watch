import { cgUrl, cgHeaders } from "../coingecko";
import { RATE_LIMITS } from "../rate-limit";
import { sleepWithSignal, throwIfAborted } from "../abort";
import { applyInvalidShapeDiagnostic, buildCapSkipDiagnostic } from "../pricing-provider-lifecycle";
import { createPricingAssetAttempt, type PricingProviderAttemptDiagnostic, type PricingProviderRejectionReason } from "../pricing-provider-diagnostics";
import { isReviewedAddressPriceTargetOverride } from "./reviewed-target-overrides";
import type { AddressPriceQuote, AddressPriceTarget } from "./types";
import {
  ADDRESS_PROVIDER_MIN_LIQUIDITY_USD,
  chunk,
  finalizeAddressPriceDiagnosticAttempts,
  fetchProviderJson,
  groupTargetsByProviderChain,
  incrementReason,
  isRecord,
  parseNonNegativeNumber,
  parsePositiveNumber,
} from "./shared";

const CG_ONCHAIN_ADDRESS_MAX_REQUESTS = 5;
const CG_ONCHAIN_ADDRESS_BATCH_SIZE = 30;

function buildRoundRobinNetworkBatches(
  targets: AddressPriceTarget[],
): Array<{ providerChainId: string; targets: AddressPriceTarget[] }> {
  const reviewedTargets: AddressPriceTarget[] = [];
  const remainingTargets: AddressPriceTarget[] = [];
  for (const target of targets) {
    (isReviewedAddressPriceTargetOverride({
      stablecoinId: target.stablecoinId,
      chain: target.chain,
      address: target.address,
    }) ? reviewedTargets : remainingTargets).push(target);
  }
  const networks = [...groupTargetsByProviderChain([...reviewedTargets, ...remainingTargets])].map(
    ([providerChainId, networkTargets]) => ({
      providerChainId,
      batches: chunk(networkTargets, CG_ONCHAIN_ADDRESS_BATCH_SIZE),
    }),
  );
  const batches: Array<{ providerChainId: string; targets: AddressPriceTarget[] }> = [];
  for (let batchIndex = 0; ; batchIndex += 1) {
    let foundBatch = false;
    for (const network of networks) {
      const batch = network.batches[batchIndex];
      if (!batch) continue;
      batches.push({ providerChainId: network.providerChainId, targets: batch });
      foundBatch = true;
    }
    if (!foundBatch) break;
  }
  return batches;
}

export async function runCoingeckoOnchainAddressProvider(
  targets: AddressPriceTarget[],
  apiKey: string | null,
  signal: AbortSignal | undefined,
  nowSec: number,
  deadlineMs: number,
) {
  const quotes: AddressPriceQuote[] = [];
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];
  const rejectedTargets: Partial<Record<PricingProviderRejectionReason, number>> = {};
  const processedTargets = new Set<AddressPriceTarget>();
  let successfulRequests = 0;
  let attemptedRequests = 0;

  for (const { providerChainId, targets: batch } of buildRoundRobinNetworkBatches(targets)) {
    throwIfAborted(signal);
    if (!(attemptedRequests < CG_ONCHAIN_ADDRESS_MAX_REQUESTS && Date.now() < deadlineMs)) break;
    if (attemptedRequests > 0) {
      await sleepWithSignal(RATE_LIMITS.COINGECKO_ONCHAIN_MS, signal);
    }
    attemptedRequests += 1;
    const url = cgUrl(
      `/onchain/networks/${providerChainId}/tokens/multi/${batch.map((target) => target.address).join(",")}`,
      apiKey,
    );
    const { json, diagnostic: rawDiagnostic } = await fetchProviderJson({
      url,
      candidateCount: batch.length,
      targets: batch,
      signal,
      init: { headers: cgHeaders({}, apiKey) },
    });
    let diagnostic = rawDiagnostic;
    const data = isRecord(json) && Array.isArray(json.data) ? json.data : null;
    if (data) {
      const matchedCountBefore = quotes.length;
      const byAddress = new Map<string, Record<string, unknown>>();
      for (const entry of data) {
        if (!isRecord(entry) || !isRecord(entry.attributes)) continue;
        const address = entry.attributes.address;
        if (typeof address !== "string") continue;
        byAddress.set(address.toLowerCase(), entry.attributes);
      }
      for (const target of batch) {
        const attrs = byAddress.get(target.address.toLowerCase());
        if (!attrs) {
          incrementReason(rejectedTargets, "missing-quote");
          continue;
        }
        const priceUsd = parsePositiveNumber(attrs.price_usd);
        if (!priceUsd) {
          incrementReason(rejectedTargets, "missing-quote");
          continue;
        }
        const liquidityUsd = parseNonNegativeNumber(attrs.total_reserve_in_usd);
        const reviewedOverride = isReviewedAddressPriceTargetOverride({
          stablecoinId: target.stablecoinId,
          chain: target.chain,
          address: target.address,
        });
        if (liquidityUsd == null && !reviewedOverride) {
          incrementReason(rejectedTargets, "missing-liquidity");
          continue;
        }
        if (liquidityUsd != null && liquidityUsd < ADDRESS_PROVIDER_MIN_LIQUIDITY_USD) {
          incrementReason(rejectedTargets, "price-rejected");
          continue;
        }
        const volume = isRecord(attrs.volume_usd) ? parseNonNegativeNumber(attrs.volume_usd.h24) : null;
        quotes.push({
          stablecoinId: target.stablecoinId,
          source: "coingecko-onchain-address",
          chain: target.chain,
          address: target.address,
          priceUsd,
          observedAt: nowSec,
          observedAtMode: "local_fetch",
          ...(liquidityUsd != null ? { liquidityUsd } : {}),
          volume24hUsd: volume ?? undefined,
          metadata: { providerChainId },
        });
      }
      diagnostic.responseRowCount = data.length;
      diagnostic.matchedCount = quotes.length - matchedCountBefore;
      diagnostic.success = true;
      successfulRequests += 1;
    } else if (json != null) {
      diagnostic = applyInvalidShapeDiagnostic(diagnostic, "Expected CoinGecko onchain tokens/multi payload");
    }
    for (const target of batch) processedTargets.add(target);
    diagnostics.push(finalizeAddressPriceDiagnosticAttempts(diagnostic, quotes));
  }
  const skippedTargets = targets.filter((target) => !processedTargets.has(target));
  if (skippedTargets.length > 0) {
    const diagnostic = buildCapSkipDiagnostic(
      { source: "coingecko-onchain-address", label: "CoinGecko onchain" },
      skippedTargets.length,
    );
    const deadlineReached = Date.now() >= deadlineMs;
    diagnostic.assetAttempts = skippedTargets.slice(0, 100).map((target) => createPricingAssetAttempt({
      assetId: target.stablecoinId,
      adapter: "coingecko-onchain-address",
      chain: target.chain,
      target: target.address,
      state: "skipped",
      skipReason: deadlineReached ? "deadline" : "request-cap",
      rejectionClass: deadlineReached ? "timeout" : "cap",
      candidateAt: Math.floor(Date.now() / 1000),
    }));
    diagnostics.push(diagnostic);
  }
  return { quotes, diagnostics, rejectedTargets, successfulRequests, attemptedRequests };
}
