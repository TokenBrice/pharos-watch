import { getDsTrackedTokenPriceUsd, type DsPair } from "../dexscreener";
import { throwIfAborted } from "../abort";
import { applyInvalidShapeDiagnostic } from "../pricing-provider-lifecycle";
import { median } from "@shared/lib/stats";
import {
  ADDRESS_PROVIDER_MIN_LIQUIDITY_USD,
  chunk,
  createAddressProviderRunner,
  fetchProviderJson,
  groupTargetsByProviderChain,
  incrementReason,
  isRecord,
} from "./shared";
import type { AddressPriceProviderRunResult, AddressPriceQuote, AddressPriceTarget } from "./types";
import type { PricingProviderRejectionReason } from "../pricing-provider-diagnostics";

// DexScreener's public endpoint sits behind a Cloudflare WAF. Keep this
// opportunistic augmentation lane to one batch per sync so quarter-hourly
// primary pricing does not trip source-wide 1015 rate limits.
const DEXSCREENER_ADDRESS_MAX_REQUESTS = 1;

function isDsPair(value: unknown): value is DsPair {
  if (!isRecord(value)) return false;
  return typeof value.chainId === "string" &&
    typeof value.dexId === "string" &&
    typeof value.pairAddress === "string" &&
    isRecord(value.baseToken) &&
    typeof value.baseToken.address === "string" &&
    typeof value.baseToken.symbol === "string" &&
    isRecord(value.quoteToken) &&
    typeof value.quoteToken.address === "string" &&
    typeof value.quoteToken.symbol === "string";
}

function getTrackedTokenSymbol(pair: DsPair, targetAddress: string): string | null {
  const tracked = targetAddress.toLowerCase();
  if (pair.baseToken.address.toLowerCase() === tracked) return pair.baseToken.symbol;
  if (pair.quoteToken.address.toLowerCase() === tracked) return pair.quoteToken.symbol;
  return null;
}

function buildDexScreenerQuotes(
  targets: AddressPriceTarget[],
  pairs: DsPair[],
  nowSec: number,
  rejectedTargets: Partial<Record<PricingProviderRejectionReason, number>>,
  batchRejectedTargets: Partial<Record<PricingProviderRejectionReason, number>>,
): AddressPriceQuote[] {
  const quotes: AddressPriceQuote[] = [];
  for (const target of targets) {
    const targetAddress = target.address.toLowerCase();
    const usablePairs = pairs.filter((pair) => {
      const trackedSymbol = getTrackedTokenSymbol(pair, targetAddress);
      if (!trackedSymbol) return false;
      if (trackedSymbol.toUpperCase() !== target.symbol.toUpperCase()) return false;
      const liquidity = pair.liquidity?.usd;
      return typeof liquidity === "number" && Number.isFinite(liquidity) && liquidity >= ADDRESS_PROVIDER_MIN_LIQUIDITY_USD;
    });
    const prices = usablePairs
      .map((pair) => getDsTrackedTokenPriceUsd(pair, targetAddress).priceUsd)
      .filter((price): price is number => typeof price === "number" && Number.isFinite(price) && price > 0);
    const priceUsd = median(prices);
    if (priceUsd == null) {
      incrementReason(rejectedTargets, "missing-quote");
      incrementReason(batchRejectedTargets, "missing-quote");
      continue;
    }
    const liquidityUsd = usablePairs.reduce((sum, pair) => sum + (pair.liquidity?.usd ?? 0), 0);
    quotes.push({
      stablecoinId: target.stablecoinId,
      source: "dexscreener-address",
      chain: target.chain,
      address: target.address,
      priceUsd,
      observedAt: nowSec,
      observedAtMode: "local_fetch",
      liquidityUsd,
      volume24hUsd: usablePairs.reduce((sum, pair) => sum + (pair.volume?.h24 ?? 0), 0),
      poolCount: usablePairs.length,
      metadata: {
        providerChainId: target.providerChainId,
        dexIds: [...new Set(usablePairs.map((pair) => pair.dexId))],
        pairAddresses: usablePairs.slice(0, 5).map((pair) => pair.pairAddress),
      },
    });
  }
  return quotes;
}

export async function runDexScreenerAddressProvider(
  targets: AddressPriceTarget[],
  signal: AbortSignal | undefined,
  nowSec: number,
  deadlineMs: number,
): Promise<AddressPriceProviderRunResult> {
  const runner = createAddressProviderRunner({
    provider: "dexscreener-address",
    label: "DexScreener",
    targets,
    deadlineMs,
    maxRequests: DEXSCREENER_ADDRESS_MAX_REQUESTS,
  });
  const { quotes, rejectedTargets } = runner;

  const grouped = groupTargetsByProviderChain(targets);
  for (const [providerChainId, chainTargets] of grouped) {
    throwIfAborted(signal);
    for (const batch of chunk(chainTargets, 30)) {
      throwIfAborted(signal);
      if (!runner.canStartRequest()) break;
      runner.beginRequest();
      const url = `https://api.dexscreener.com/tokens/v1/${providerChainId}/${batch.map((target) => target.address).join(",")}`;
      const { json, diagnostic: rawDiagnostic } = await fetchProviderJson({
        provider: "dexscreener-address",
        url,
        candidateCount: batch.length,
        targets: batch,
        signal,
      });
      let diagnostic = rawDiagnostic;
      if (Array.isArray(json)) {
        const pairs = json.filter(isDsPair);
        const batchRejectedTargets: Partial<Record<PricingProviderRejectionReason, number>> = {};
        const batchQuotes = buildDexScreenerQuotes(batch, pairs, nowSec, rejectedTargets, batchRejectedTargets);
        quotes.push(...batchQuotes);
        diagnostic.responseRowCount = pairs.length;
        diagnostic.matchedCount = batchQuotes.length;
        diagnostic.resolvedCount = batchQuotes.length;
        diagnostic.rejectionReasonCounts = Object.keys(batchRejectedTargets).length ? { ...batchRejectedTargets } : undefined;
        diagnostic.success = true;
        runner.recordSuccess();
      } else if (json != null) {
        diagnostic = applyInvalidShapeDiagnostic(diagnostic, "Expected DexScreener token-address response array");
      }
      runner.markProcessed(batch);
      runner.recordDiagnostic(diagnostic);
      if (!diagnostic.success) {
        break;
      }
    }
    if (!runner.canStartRequest()) break;
  }
  return runner.finish();
}
