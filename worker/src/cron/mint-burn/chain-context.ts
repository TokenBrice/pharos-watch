import { getMintBurnBlockNumber, mintBurnRpcEndpoints } from "../../lib/mint-burn-pipeline/rpc";
import type { ChainRpcConfig, RpcEndpoint } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import type { MintBurnTxContext } from "../../lib/mint-burn-bridge-classifier";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";

export interface MintBurnChainContext {
  chainHead: number;
  rpcEndpoints: readonly RpcEndpoint[];
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
    const chainHead = await getMintBurnBlockNumber(rpcEndpoints, input.budget, input.signal);
    if (chainHead === null) {
      throw new Error(`Failed to get ${chainId} chain head`);
    }
    chainContexts.set(chainId, {
      chainHead,
      rpcEndpoints,
      chainTimestampCache: new Map<string, number>(),
      txContextCache: new Map<string, MintBurnTxContext | null>(),
    });
  }
  return chainContexts;
}
