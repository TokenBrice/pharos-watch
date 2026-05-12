import { sleepWithSignal } from "../abort";
import type {
  AddressPriceProviderRuntimeConfig,
  AddressPriceProviderRunResult,
  AddressPriceQuote,
  AddressPriceTarget,
} from "./types";
import {
  ADDRESS_PROVIDER_MIN_LIQUIDITY_USD,
  emptyProviderResult,
  fetchProviderJson,
  incrementReason,
  isRecord,
  parseNonNegativeNumber,
  parseObservedAt,
  parsePositiveNumber,
} from "./shared";

const BIRDEYE_ADDRESS_MAX_REQUESTS = 10;
const BIRDEYE_REQUEST_SPACING_MS = 1_000;

export async function runBirdeyeAddressProvider(
  targets: AddressPriceTarget[],
  config: AddressPriceProviderRuntimeConfig,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<AddressPriceProviderRunResult> {
  const apiKey = config.birdeyeApiKey?.trim();
  if (!apiKey) return emptyProviderResult("birdeye-address", targets.length, "missing-provider");
  const diagnostics: AddressPriceProviderRunResult["diagnostics"] = [];
  const quotes: AddressPriceQuote[] = [];
  const rejectedTargets: AddressPriceProviderRunResult["rejectedTargets"] = {};
  let successfulRequests = 0;
  let attemptedRequests = 0;

  for (const target of targets.filter((entry) => entry.providerChainId === "solana").slice(0, BIRDEYE_ADDRESS_MAX_REQUESTS)) {
    if (Date.now() >= deadlineMs) break;
    if (attemptedRequests > 0) {
      await sleepWithSignal(BIRDEYE_REQUEST_SPACING_MS, signal);
    }
    attemptedRequests += 1;
    const url = `https://public-api.birdeye.so/defi/price?address=${encodeURIComponent(target.address)}&include_liquidity=true&ui_amount_mode=raw`;
    const { json, diagnostic } = await fetchProviderJson({
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
    const data = isRecord(json) && isRecord(json.data) ? json.data : null;
    if (data) {
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
            priceChange24h: data.priceChange24h,
            priceInNative: data.priceInNative,
          },
        });
      }
      diagnostic.responseRowCount = 1;
      diagnostic.matchedCount = quotes.filter((quote) => quote.source === "birdeye-address").length;
      diagnostic.success = true;
      successfulRequests += 1;
    } else if (json != null) {
      diagnostic.errorClass = "invalid-shape";
      diagnostic.errorMessage = "Expected Birdeye price data object";
      diagnostic.rejectionReasonCounts = { "invalid-shape": 1 };
    }
    diagnostics.push(diagnostic);
  }

  return {
    quotes,
    diagnostics,
    attemptedTargets: Math.min(targets.length, BIRDEYE_ADDRESS_MAX_REQUESTS),
    matchedTargets: quotes.length,
    rejectedTargets,
    successfulRequests,
    attemptedRequests,
  };
}
