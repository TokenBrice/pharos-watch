import { sleepWithSignal, throwIfAborted } from "../abort";
import { applyInvalidShapeDiagnostic } from "../pricing-provider-lifecycle";
import { numberValue } from "@shared/lib/type-guards";
import type {
  AddressPriceProviderRuntimeConfig,
  AddressPriceProviderRunResult,
  AddressPriceTarget,
} from "./types";
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

function isBirdeyeMissingPricePayload(json: unknown): json is Record<string, unknown> {
  return isRecord(json) && json.success === true && "data" in json && json.data == null;
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

  // targets are pre-filtered to solana-only by buildAddressPriceTargetsByProvider (index.ts)
  for (const target of targets.slice(0, BIRDEYE_ADDRESS_MAX_REQUESTS)) {
    throwIfAborted(signal);
    if (Date.now() >= deadlineMs) break;
    if (attemptedRequests > 0) {
      await sleepWithSignal(BIRDEYE_REQUEST_SPACING_MS, signal);
    }
    attemptedRequests += 1;
    const url = `https://public-api.birdeye.so/defi/price?address=${encodeURIComponent(target.address)}&include_liquidity=true&ui_amount_mode=raw`;
    const { json, diagnostic: rawDiagnostic } = await fetchProviderJson({
      provider: "birdeye-address",
      url,
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
    const data = isRecord(json) && isRecord(json.data) ? json.data : null;
    if (data) {
      const matchedCountBefore = quotes.length;
      const priceUsd = parsePositiveNumber(data.value);
      const liquidityUsd = parseNonNegativeNumber(data.liquidity);
      if (!priceUsd) {
        incrementReason(rejectedTargets, "missing-quote");
      } else if (liquidityUsd != null && liquidityUsd < ADDRESS_PROVIDER_MIN_LIQUIDITY_USD) {
        incrementReason(rejectedTargets, "price-rejected");
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
      diagnostic.responseRowCount = 1;
      diagnostic.matchedCount = quotes.length - matchedCountBefore;
      diagnostic.success = true;
      successfulRequests += 1;
    } else if (isBirdeyeMissingPricePayload(json)) {
      incrementReason(rejectedTargets, "missing-quote");
      diagnostic.responseRowCount = 0;
      diagnostic.matchedCount = 0;
      diagnostic.success = true;
      diagnostic.rejectionReasonCounts = { "missing-quote": 1 };
      successfulRequests += 1;
    } else if (json != null) {
      diagnostic = applyInvalidShapeDiagnostic(diagnostic, "Expected Birdeye price data object");
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
