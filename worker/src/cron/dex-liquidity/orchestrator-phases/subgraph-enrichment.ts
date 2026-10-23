import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEventArgs } from "../../../lib/structured-log";
import { rethrowIfAborted } from "../../../lib/abort";
import type { PriceValidationReferences } from "../../../lib/price-validation";
import { UNISWAP_V4_SUBGRAPHS, UNIV3_SUBGRAPHS } from "../constants";
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
import {
  reconcileUniV3CandidateSnapshots,
  type UniV3CandidateCarryForwardTelemetry,
} from "../univ3-candidate-snapshot";
import {
  reconcileUniswapV4CandidateSnapshots,
  type UniswapV4CandidateCarryForwardTelemetry,
} from "../uniswap-v4-candidate-snapshot";
import type { SubgraphChainFailure } from "../subgraph-family-runner";

/** One failed subgraph chain read, named by its `failedSources` family. */
export type SubgraphFailureTelemetry = Array<SubgraphChainFailure & {
  source: "univ3-subgraph" | "uniswap-v4-subgraph";
}>;

export interface SubgraphEnrichmentPhaseResult {
  uniV3PoolFees: Map<string, number>;
  uniV3SymbolFees: Map<string, number>;
  uniV3PriceObs: Map<string, DexPriceObs[]>;
  uniV3ExecutionCandidates: UniV3Lookups["uniV3ExecutionCandidates"];
  uniswapV4ExecutionCandidates: UniswapV4Lookups["uniswapV4ExecutionCandidates"];
  /** Per-chain snapshot decisions; empty without a Graph key (the family is off, not failed). */
  uniV3CandidateCarryForward: UniV3CandidateCarryForwardTelemetry;
  /** Same decisions for Uniswap V4; empty without a Graph key. */
  uniswapV4CandidateCarryForward: UniswapV4CandidateCarryForwardTelemetry;
  /** Why each `univ3-subgraph:<chain>` / `uniswap-v4-subgraph:<chain>` failed. */
  subgraphFailures: SubgraphFailureTelemetry;
}

export async function fetchSubgraphEnrichmentPhase(params: {
  db: D1Database;
  nowSec: number;
  graphApiKey: string | null;
  symbolToChainScopedIds: SymbolLookups["symbolToChainScopedIds"];
  chainAddressToId: SymbolLookups["chainAddressToId"];
  uniswapV4ExactPoolIdsByChain: ReadonlyMap<string, readonly string[]>;
  signal?: AbortSignal;
  validationReferences: PriceValidationReferences;
}): Promise<SubgraphEnrichmentPhaseResult & { failedSources: string[] }> {
  const failedSources: string[] = [];
  const subgraphFailures: SubgraphFailureTelemetry = [];

  let uniV3PoolFees = new Map<string, number>();
  let uniV3SymbolFees = new Map<string, number>();
  let uniV3PriceObs = new Map<string, DexPriceObs[]>();
  let uniV3ExecutionCandidates: UniV3Lookups["uniV3ExecutionCandidates"] = new Map();
  const uniV3Chains = Object.keys(UNIV3_SUBGRAPHS);
  let uniV3FailedChains = new Set<string>(uniV3Chains);
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
    uniV3FailedChains = new Set(uniV3Data.failedChains);
    subgraphFailures.push(...uniV3Data.chainFailures.map((failure) => ({ source: "univ3-subgraph" as const, ...failure })));
    failedSources.push(
      ...uniV3Data.failedChains.map((chain) => `univ3-subgraph:${chain}`),
    );
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    logWorkerEventArgs("handler", "warn", "[dex-liquidity] UniV3 fetch failed (non-fatal):", err);
    failedSources.push("univ3-subgraph");
  }
  // A failed chain keeps `univ3-subgraph:<chain>` in failedSources: the carry
  // restores target identity, it does not make the source healthy.
  const uniV3CandidateCarryForward = params.graphApiKey
    ? await reconcileUniV3CandidateSnapshots({
        db: params.db,
        nowSec: params.nowSec,
        chains: uniV3Chains,
        failedChains: uniV3FailedChains,
        candidates: uniV3ExecutionCandidates,
        signal: params.signal,
      })
    : [];

  let uniswapV4ExecutionCandidates:
    UniswapV4Lookups["uniswapV4ExecutionCandidates"] = new Map();
  const uniswapV4Chains = Object.keys(UNISWAP_V4_SUBGRAPHS);
  let uniswapV4FailedChains = new Set<string>(uniswapV4Chains);
  let exactAnsweredPoolIdsByChain: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  try {
    const uniswapV4Data = await fetchUniswapV4Data(
      params.graphApiKey,
      params.uniswapV4ExactPoolIdsByChain,
      params.signal,
    );
    uniswapV4ExecutionCandidates =
      uniswapV4Data.uniswapV4ExecutionCandidates;
    uniswapV4FailedChains = new Set(uniswapV4Data.failedChains);
    exactAnsweredPoolIdsByChain = uniswapV4Data.exactAnsweredPoolIdsByChain;
    subgraphFailures.push(...uniswapV4Data.chainFailures.map((failure) => ({ source: "uniswap-v4-subgraph" as const, ...failure })));
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
  // As for Uni V3, a carried chain keeps `uniswap-v4-subgraph:<chain>` failed.
  const uniswapV4CandidateCarryForward = params.graphApiKey
    ? await reconcileUniswapV4CandidateSnapshots({
        db: params.db,
        nowSec: params.nowSec,
        chains: uniswapV4Chains,
        failedChains: uniswapV4FailedChains,
        candidates: uniswapV4ExecutionCandidates,
        exactAnsweredPoolIdsByChain,
        signal: params.signal,
      })
    : [];

  return {
    uniV3PoolFees,
    uniV3SymbolFees,
    uniV3PriceObs,
    uniV3ExecutionCandidates,
    uniswapV4ExecutionCandidates,
    uniV3CandidateCarryForward,
    uniswapV4CandidateCarryForward,
    subgraphFailures,
    failedSources,
  };
}
