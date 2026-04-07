import { appendTokenBatchPriceObservations } from "./token-price-observations";
import type { DexPriceObs } from "./types";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { throwIfAborted } from "../../lib/abort";

export interface ProviderChainAddress {
  chain: string;
  address: string;
  stablecoinId: string;
}

interface RunTokenBatchPriceFetchParams<TToken> {
  providerLabel: string;
  sourceLabel: string;
  signal?: AbortSignal;
  chainAddresses: Map<string, ProviderChainAddress[]>;
  deadlineMs?: number;
  references?: PriceValidationReferences;
  beforeRequest?: (requestCount: number, signal?: AbortSignal) => Promise<void>;
  fetchTokens: (
    providerChain: string,
    addresses: string[],
    signal?: AbortSignal,
  ) => Promise<TToken[]>;
  getAddress: (token: TToken) => string;
  getPriceUsd: (token: TToken) => number;
  getTvlUsd: (token: TToken) => number;
}

export async function runTokenBatchPriceFetch<TToken>(
  params: RunTokenBatchPriceFetchParams<TToken>,
): Promise<{ priceObs: Map<string, DexPriceObs[]>; requestCount: number }> {
  const priceObs = new Map<string, DexPriceObs[]>();
  let requestCount = 0;

  for (const [providerChain, tokens] of params.chainAddresses) {
    throwIfAborted(params.signal);

    for (let i = 0; i < tokens.length; i += 30) {
      if (params.deadlineMs && Date.now() >= params.deadlineMs) {
        console.log(
          `[dex-liquidity] ${params.providerLabel} budget exhausted after ${requestCount} requests, yielding partial results`,
        );
        return { priceObs, requestCount };
      }

      const batch = tokens.slice(i, i + 30);
      const addresses = batch.map((token) => token.address);

      if (params.beforeRequest) {
        await params.beforeRequest(requestCount, params.signal);
      }
      requestCount++;

      try {
        const fetchedTokens = await params.fetchTokens(providerChain, addresses, params.signal);
        appendTokenBatchPriceObservations({
          priceObs,
          batch,
          tokens: fetchedTokens,
          sourceLabel: params.sourceLabel,
          references: params.references,
          getAddress: params.getAddress,
          getPriceUsd: params.getPriceUsd,
          getTvlUsd: params.getTvlUsd,
        });
      } catch (error) {
        if (params.signal?.aborted) throw error;
        console.warn(`[dex-liquidity] ${params.providerLabel} error for ${providerChain}:`, error);
      }
    }
  }

  return { priceObs, requestCount };
}
