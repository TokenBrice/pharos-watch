import { sleepWithSignal, throwIfAborted } from "../abort";
import { applyInvalidShapeDiagnostic, buildCapSkipDiagnostic } from "../pricing-provider-lifecycle";
import { numberValue } from "@shared/lib/type-guards";
import type { AddressPriceProviderRuntimeConfig, AddressPriceProviderRunResult, AddressPriceTarget } from "./types";
import {
  ADDRESS_PROVIDER_MIN_LIQUIDITY_USD,
  createProviderRunState,
  emptyProviderResult,
  fetchProviderJson,
  incrementReason,
  isRecord,
  narrowMetadata,
  parseNonNegativeNumber,
  parseObservedAt,
  parsePositiveNumber,
} from "./shared";

const BIRDEYE_ADDRESS_MAX_REQUESTS = 10;
const BIRDEYE_REQUEST_SPACING_MS = 1_000;

function isBirdeyePricePayload(json: unknown): json is { data: Record<string, unknown> | null } {
  return isRecord(json) && json.success === true && "data" in json && (json.data == null || isRecord(json.data));
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
  const cappedTargets = Math.max(0, targets.length - BIRDEYE_ADDRESS_MAX_REQUESTS);

  // targets are pre-filtered to solana-only by buildAddressPriceTargetsByProvider (index.ts).
  for (const target of targets.slice(0, BIRDEYE_ADDRESS_MAX_REQUESTS)) {
    throwIfAborted(signal);
    if (Date.now() >= deadlineMs) break;
    if (attemptedRequests > 0) {
      await sleepWithSignal(BIRDEYE_REQUEST_SPACING_MS, signal);
    }
    attemptedRequests += 1;
    const url = new URL("https://public-api.birdeye.so/defi/price");
    url.searchParams.set("address", target.address);
    url.searchParams.set("include_liquidity", "true");
    url.searchParams.set("ui_amount_mode", "raw");
    const { json, diagnostic: rawDiagnostic } = await fetchProviderJson({
      provider: "birdeye-address",
      url: url.toString(),
      init: {
        headers: {
          "X-API-KEY": apiKey,
          "x-chain": target.providerChainId,
        },
      },
      candidateCount: 1,
      signal,
    });
    let diagnostic = rawDiagnostic;
    if (isBirdeyePricePayload(json)) {
      const matchedCountBefore = quotes.length;
      const requestRejectedTargets: AddressPriceProviderRunResult["rejectedTargets"] = {};
      const data = json.data;
      const priceUsd = data ? parsePositiveNumber(data.value) : null;
      const liquidityUsd = data ? parseNonNegativeNumber(data.liquidity) : null;
      if (!data || !priceUsd) {
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
          observedAt: parseObservedAt(data.updateUnixTime ?? data.updateHumanTime),
          observedAtMode: "upstream",
          ...(liquidityUsd != null ? { liquidityUsd } : {}),
          metadata: {
            providerChainId: target.providerChainId,
            ...narrowMetadata({
              priceChange24h: numberValue(data.priceChange24h),
              priceInNative: numberValue(data.priceInNative),
            }),
          },
        });
      }
      diagnostic.responseRowCount = data ? 1 : 0;
      diagnostic.matchedCount = quotes.length - matchedCountBefore;
      diagnostic.success = true;
      if (Object.keys(requestRejectedTargets).length > 0) {
        diagnostic.rejectionReasonCounts = requestRejectedTargets;
      }
      successfulRequests += 1;
    } else if (json != null) {
      diagnostic = applyInvalidShapeDiagnostic(diagnostic, "Expected Birdeye price data object");
    }
    diagnostics.push(diagnostic);
  }

  if (cappedTargets > 0) {
    diagnostics.push(buildCapSkipDiagnostic({ source: "birdeye-address", label: "Birdeye" }, cappedTargets));
  }

  return {
    quotes,
    diagnostics,
    rejectedTargets,
    successfulRequests,
    attemptedRequests,
  };
}
