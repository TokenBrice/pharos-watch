import { throwIfAborted } from "../abort";
import { applyInvalidShapeDiagnostic } from "../pricing-provider-lifecycle";
import { numberValue } from "@shared/lib/type-guards";
import type { AddressPriceProviderRuntimeConfig, AddressPriceProviderRunResult, AddressPriceTarget } from "./types";
import {
  ADDRESS_PROVIDER_MIN_LIQUIDITY_USD,
  createProviderRunState,
  emptyProviderResult,
  fetchProviderJson,
  groupTargetsByProviderChain,
  incrementReason,
  isRecord,
  narrowMetadata,
  normalizeAddressForKey,
  parseNonNegativeNumber,
  parseObservedAt,
  parsePositiveNumber,
} from "./shared";

const BIRDEYE_MULTI_PRICE_BATCH_SIZE = 100;

function getBirdeyePriceRow(data: Record<string, unknown>, target: AddressPriceTarget): unknown {
  if (Object.prototype.hasOwnProperty.call(data, target.address)) {
    return data[target.address];
  }

  const normalizedTarget = normalizeAddressForKey(target.address);
  for (const [address, row] of Object.entries(data)) {
    if (normalizeAddressForKey(address) === normalizedTarget) {
      return row;
    }
  }

  return undefined;
}

export async function runBirdeyeAddressProvider(
  targets: AddressPriceTarget[],
  config: AddressPriceProviderRuntimeConfig,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<AddressPriceProviderRunResult> {
  const apiKey = config.birdeyeApiKey?.trim();
  if (!apiKey) return emptyProviderResult("birdeye-address", targets.length, "missing-provider");
  const state = createProviderRunState();
  const { diagnostics, quotes, rejectedTargets } = state;
  let { successfulRequests, attemptedRequests } = state;

  // targets are pre-filtered to solana-only by buildAddressPriceTargetsByProvider (index.ts).
  const targetBatch = targets.slice(0, BIRDEYE_MULTI_PRICE_BATCH_SIZE);
  for (const [providerChainId, chainTargets] of groupTargetsByProviderChain(targetBatch)) {
    throwIfAborted(signal);
    if (Date.now() >= deadlineMs) break;
    attemptedRequests += 1;
    const url = new URL("https://public-api.birdeye.so/defi/multi_price");
    url.searchParams.set("list_address", chainTargets.map((target) => target.address).join(","));
    url.searchParams.set("include_liquidity", "true");
    url.searchParams.set("ui_amount_mode", "raw");
    const { json, diagnostic: rawDiagnostic } = await fetchProviderJson({
      provider: "birdeye-address",
      url: url.toString(),
      init: {
        headers: {
          "X-API-KEY": apiKey,
          "x-chain": providerChainId,
        },
      },
      candidateCount: chainTargets.length,
      signal,
    });
    let diagnostic = rawDiagnostic;
    const payloadIsUsable =
      isRecord(json) && json.success === true && "data" in json && (json.data == null || isRecord(json.data));
    if (payloadIsUsable) {
      const matchedCountBefore = quotes.length;
      const requestRejectedTargets: AddressPriceProviderRunResult["rejectedTargets"] = {};
      const data = isRecord(json.data) ? json.data : null;
      for (const target of chainTargets) {
        const row = data ? getBirdeyePriceRow(data, target) : null;
        if (!isRecord(row)) {
          incrementReason(rejectedTargets, "missing-quote");
          incrementReason(requestRejectedTargets, "missing-quote");
          continue;
        }

        const priceUsd = parsePositiveNumber(row.value);
        const liquidityUsd = parseNonNegativeNumber(row.liquidity);
        if (!priceUsd) {
          incrementReason(rejectedTargets, "missing-quote");
          incrementReason(requestRejectedTargets, "missing-quote");
        } else if (liquidityUsd != null && liquidityUsd < ADDRESS_PROVIDER_MIN_LIQUIDITY_USD) {
          incrementReason(rejectedTargets, "price-rejected");
          incrementReason(requestRejectedTargets, "price-rejected");
        } else {
          quotes.push({
            stablecoinId: target.stablecoinId,
            source: "birdeye-address",
            chain: target.chain,
            address: target.address,
            priceUsd,
            observedAt: parseObservedAt(row.updateUnixTime ?? row.updateHumanTime),
            observedAtMode: "upstream",
            ...(liquidityUsd != null ? { liquidityUsd } : {}),
            metadata: {
              providerChainId: target.providerChainId,
              ...narrowMetadata({
                priceChange24h: numberValue(row.priceChange24h),
                priceInNative: numberValue(row.priceInNative),
              }),
            },
          });
        }
      }
      diagnostic.responseRowCount = data ? Object.keys(data).length : 0;
      diagnostic.matchedCount = quotes.length - matchedCountBefore;
      diagnostic.success = true;
      if (Object.keys(requestRejectedTargets).length > 0) {
        diagnostic.rejectionReasonCounts = requestRejectedTargets;
      }
      successfulRequests += 1;
    } else if (json != null) {
      diagnostic = applyInvalidShapeDiagnostic(diagnostic, "Expected Birdeye multi_price data object");
    }
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
