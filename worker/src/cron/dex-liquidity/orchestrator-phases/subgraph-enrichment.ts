import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEventArgs } from "../../../lib/structured-log";
import { rethrowIfAborted } from "../../../lib/abort";
import type { PriceValidationReferences } from "../../../lib/price-validation";
import {
  fetchUniswapV4Data,
  fetchUniV3Data,
} from "../subgraph-source-families";
import type {
  DexPriceObs,
  SymbolLookups,
  UniswapV4Lookups,
  UniV3Lookups,
} from "../types";

export interface SubgraphEnrichmentPhaseResult {
  uniV3PoolFees: Map<string, number>;
  uniV3SymbolFees: Map<string, number>;
  uniV3PriceObs: Map<string, DexPriceObs[]>;
  uniV3ExecutionCandidates: UniV3Lookups["uniV3ExecutionCandidates"];
  uniswapV4ExecutionCandidates: UniswapV4Lookups["uniswapV4ExecutionCandidates"];
}

export async function fetchSubgraphEnrichmentPhase(params: {
  graphApiKey: string | null;
  symbolToChainScopedIds: SymbolLookups["symbolToChainScopedIds"];
  chainAddressToId: SymbolLookups["chainAddressToId"];
  signal?: AbortSignal;
  validationReferences: PriceValidationReferences;
}): Promise<SubgraphEnrichmentPhaseResult & { failedSources: string[] }> {
  const failedSources: string[] = [];

  let uniV3PoolFees = new Map<string, number>();
  let uniV3SymbolFees = new Map<string, number>();
  let uniV3PriceObs = new Map<string, DexPriceObs[]>();
  let uniV3ExecutionCandidates: UniV3Lookups["uniV3ExecutionCandidates"] = new Map();
  try {
    const uniV3Data = await fetchUniV3Data(
      params.graphApiKey,
      params.symbolToChainScopedIds,
      params.chainAddressToId,
      params.signal,
      params.validationReferences,
    );
    uniV3PoolFees = uniV3Data.uniV3PoolFees;
    uniV3SymbolFees = uniV3Data.uniV3SymbolFees;
    uniV3PriceObs = uniV3Data.uniV3PriceObs;
    uniV3ExecutionCandidates = uniV3Data.uniV3ExecutionCandidates;
    failedSources.push(
      ...uniV3Data.failedChains.map((chain) => `univ3-subgraph:${chain}`),
    );
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    logWorkerEventArgs("handler", "warn", "[dex-liquidity] UniV3 fetch failed (non-fatal):", err);
    failedSources.push("univ3-subgraph");
  }

  let uniswapV4ExecutionCandidates:
    UniswapV4Lookups["uniswapV4ExecutionCandidates"] = new Map();
  try {
    const uniswapV4Data = await fetchUniswapV4Data(
      params.graphApiKey,
      params.signal,
    );
    uniswapV4ExecutionCandidates =
      uniswapV4Data.uniswapV4ExecutionCandidates;
    failedSources.push(
      ...uniswapV4Data.failedChains.map(
        (chain) => `uniswap-v4-subgraph:${chain}`,
      ),
    );
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    logWorkerEventArgs("handler", "warn", JSON.stringify({
      scope: "dex-liquidity",
      message: "Uniswap V4 fetch failed (non-fatal)",
      error: toErrorMessage(err),
    }));
    failedSources.push("uniswap-v4-subgraph");
  }

  return {
    uniV3PoolFees,
    uniV3SymbolFees,
    uniV3PriceObs,
    uniV3ExecutionCandidates,
    uniswapV4ExecutionCandidates,
    failedSources,
  };
}
