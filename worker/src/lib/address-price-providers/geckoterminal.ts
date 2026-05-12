import type { AddressPriceProviderRunResult, AddressPriceQuote, AddressPriceTarget } from "./types";
import {
  ADDRESS_PROVIDER_MIN_LIQUIDITY_USD,
  chunk,
  fetchProviderJson,
  groupTargetsByProviderChain,
  incrementReason,
  isRecord,
  parseNonNegativeNumber,
  parsePositiveNumber,
} from "./shared";

const GECKOTERMINAL_ADDRESS_MAX_REQUESTS = 5;

export async function runGeckoTerminalAddressProvider(
  targets: AddressPriceTarget[],
  signal: AbortSignal | undefined,
  nowSec: number,
  deadlineMs: number,
): Promise<AddressPriceProviderRunResult> {
  const diagnostics: AddressPriceProviderRunResult["diagnostics"] = [];
  const quotes: AddressPriceQuote[] = [];
  const rejectedTargets: AddressPriceProviderRunResult["rejectedTargets"] = {};
  let successfulRequests = 0;
  let attemptedRequests = 0;

  const grouped = groupTargetsByProviderChain(targets);
  for (const [providerChainId, chainTargets] of grouped) {
    for (const batch of chunk(chainTargets, 30)) {
      if (attemptedRequests >= GECKOTERMINAL_ADDRESS_MAX_REQUESTS || Date.now() >= deadlineMs) break;
      attemptedRequests += 1;
      const url = `https://api.geckoterminal.com/api/v2/simple/networks/${providerChainId}/token_price/${batch.map((target) => target.address).join(",")}`;
      const { json, diagnostic } = await fetchProviderJson({
        provider: "geckoterminal-address",
        url,
        candidateCount: batch.length,
        signal,
      });
      const attrs = isRecord(json) && isRecord(json.data) && isRecord(json.data.attributes)
        ? json.data.attributes
        : null;
      const tokenPrices = attrs && isRecord(attrs.token_prices) ? attrs.token_prices : null;
      if (tokenPrices) {
        for (const target of batch) {
          const priceUsd = parsePositiveNumber(
            tokenPrices[target.address] ?? tokenPrices[target.address.toLowerCase()],
          );
          if (!priceUsd) {
            incrementReason(rejectedTargets, "missing-quote");
            continue;
          }
          const reserveMap = isRecord(attrs?.total_reserve_in_usd) ? attrs.total_reserve_in_usd : {};
          const volumeMap = isRecord(attrs?.h24_volume_usd) ? attrs.h24_volume_usd : {};
          const liquidityUsd = parseNonNegativeNumber(reserveMap[target.address] ?? reserveMap[target.address.toLowerCase()]);
          if (liquidityUsd != null && liquidityUsd < ADDRESS_PROVIDER_MIN_LIQUIDITY_USD) {
            incrementReason(rejectedTargets, "price-rejected");
            continue;
          }
          quotes.push({
            stablecoinId: target.stablecoinId,
            source: "geckoterminal-address",
            chain: target.chain,
            address: target.address,
            priceUsd,
            observedAt: nowSec,
            observedAtMode: "local_fetch",
            ...(liquidityUsd != null ? { liquidityUsd } : {}),
            volume24hUsd: parseNonNegativeNumber(volumeMap[target.address] ?? volumeMap[target.address.toLowerCase()]) ?? undefined,
            metadata: { providerChainId },
          });
        }
        diagnostic.responseRowCount = Object.keys(tokenPrices).length;
        diagnostic.matchedCount = quotes.filter((quote) => quote.source === "geckoterminal-address").length;
        diagnostic.success = true;
        successfulRequests += 1;
      } else if (json != null) {
        diagnostic.errorClass = "invalid-shape";
        diagnostic.errorMessage = "Expected GeckoTerminal simple token_price payload";
        diagnostic.rejectionReasonCounts = { "invalid-shape": 1 };
      }
      diagnostics.push(diagnostic);
    }
  }

  return {
    quotes,
    diagnostics,
    attemptedTargets: Math.min(targets.length, GECKOTERMINAL_ADDRESS_MAX_REQUESTS * 30),
    matchedTargets: quotes.length,
    rejectedTargets,
    successfulRequests,
    attemptedRequests,
  };
}
