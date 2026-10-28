import { getMintBurnFinalizedHead, mintBurnRpcEndpoints } from "../../lib/mint-burn-pipeline/rpc";
import type { ChainRpcConfig, RpcEndpoint } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import type { MintBurnTxContext } from "../../lib/mint-burn-bridge-classifier";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { withRpcRequestScope } from "../../lib/rpc-request-observer";

export interface MintBurnChainContext {
  /** Admitted finalized ceiling, never the provisional tip. */
  chainHead: number | null;
  rpcEndpoints: readonly RpcEndpoint[];
  endpointHeads: Map<string, number>;
  chainTimestampCache: Map<string, number>;
  txContextCache: Map<string, MintBurnTxContext | null>;
}

export async function loadMintBurnChainContexts(input: {
  configs: MintBurnContractConfig[];
  apiKey: string;
  budget: { limit: number; count: number };
  signal?: AbortSignal;
  chainRpcs?: ReadonlyMap<string, ChainRpcConfig>;
}): Promise<Map<string, MintBurnChainContext>> {
  const chainContexts = new Map<string, MintBurnChainContext>();
  for (const chainId of [...new Set(input.configs.map((config) => config.chain.chainId))]) {
    throwIfAborted(input.signal);
    const rpcEndpoints = mintBurnRpcEndpoints(chainId, input.apiKey, input.chainRpcs);
    const endpointHeads = new Map<string, number>();
    const finalized = await withRpcRequestScope({ kind: "chain-head", key: chainId, affectsRun: true },
      () => getMintBurnFinalizedHead(chainId, rpcEndpoints, input.budget, input.signal),
      (head) => head == null && input.budget.count < input.budget.limit);
    const chainHead = finalized?.number ?? null;
    chainContexts.set(chainId, {
      chainHead,
      rpcEndpoints,
      endpointHeads,
      chainTimestampCache: new Map<string, number>(),
      txContextCache: new Map<string, MintBurnTxContext | null>(),
    });
  }
  return chainContexts;
}
