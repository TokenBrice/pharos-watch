import type { DexExecutionCapabilityGate } from "@shared/types/dex-execution";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { PriceValidationReferences } from "../../../lib/pricing/price-validation";
import type { UniV3ExecutionCandidate, UniswapV4ExecutionCandidate } from "../../measured-execution/candidate-types";
import type { EvmV2ExecutionCandidate } from "../types";
import type { SymbolLookups } from "../token-resolution-types";

export interface DexExecutionTargetFactoryInput {
  context: {
    chainAddressToId: SymbolLookups["chainAddressToId"];
    symbolToChainScopedIds: SymbolLookups["symbolToChainScopedIds"];
    contractMetaByChainAddress?: SymbolLookups["contractMetaByChainAddress"];
    stablecoinPriceById?: Map<string, number>;
    validationReferences?: PriceValidationReferences;
    measuredTargetCapturedAt: number;
    uniV3ExecutionCandidates: Map<string, UniV3ExecutionCandidate[]>;
    uniswapV4ExecutionCandidates: ReadonlyMap<string, readonly UniswapV4ExecutionCandidate[]>;
  };
  identity: {
    chainNorm: string;
    protocol: string;
    poolType: string;
    pool: {
      pool: string;
      project: string;
      symbol: string;
      poolMeta?: string | null;
      underlyingTokens: string[] | null;
    };
  };
  enrichment: {
    resolvedPoolType: string;
    rawContribTvl: number;
  };
  stablecoinId: string;
}

export interface DexExecutionTargetFactoryOutput {
  evmV2ExecutionCandidate?: EvmV2ExecutionCandidate;
  executionCapabilityGate?: DexExecutionCapabilityGate;
  measuredExecutionTarget?: DexMeasuredExecutionTarget;
}
