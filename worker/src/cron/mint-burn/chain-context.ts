import { getMintBurnFinalizedHead, mintBurnRpcEndpoints } from "../../lib/mint-burn-pipeline/rpc";
import type { ChainRpcConfig, RpcEndpoint } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import type { MintBurnTxContext } from "../../lib/mint-burn-bridge-classifier";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { TronJsonRpcReader, TronRpcError } from "../../lib/tron-jsonrpc";
import type { DwellirNativeCapability } from "../../lib/dwellir-native";
import { createRateLimiter } from "../../lib/evm-logs";

export interface MintBurnChainContext {
  /** Admitted finalized ceiling, never the provisional tip. */
  chainHead: number | null;
  chainHeadFailureReason?: string;
  rpcEndpoints: readonly RpcEndpoint[];
  endpointHeads: Map<string, number>;
  chainTimestampCache: Map<string, number>;
  txContextCache: Map<string, MintBurnTxContext | null>;
  tronReader?: TronJsonRpcReader;
}

export async function loadMintBurnChainContexts(input: {
  configs: MintBurnContractConfig[];
  apiKey: string;
  budget: { limit: number; count: number };
  signal?: AbortSignal;
  chainRpcs?: ReadonlyMap<string, ChainRpcConfig>;
  dwellirNative?: DwellirNativeCapability;
  trongridApiKey?: string | null;
  trongridAllowed?: boolean;
  deadlineMs?: number;
}): Promise<Map<string, MintBurnChainContext>> {
  const chainContexts = new Map<string, MintBurnChainContext>();
  for (const chainId of [...new Set(input.configs.map((config) => config.chain.chainId))]) {
    throwIfAborted(input.signal);
    const rpcEndpoints = mintBurnRpcEndpoints(chainId, input.apiKey, input.chainRpcs);
    const tronReader = chainId === "tron" ? new TronJsonRpcReader({
      dwellirNative: input.dwellirNative, trongridApiKey: input.trongridApiKey,
      trongridAllowed: input.trongridAllowed, budget: input.budget,
      deadlineMs: input.deadlineMs ?? Date.now() + 9 * 60_000,
      rateLimit: createRateLimiter(3), signal: input.signal ?? new AbortController().signal,
    }) : undefined;
    const endpointHeads = new Map<string, number>();
    let finalized;
    let chainHeadFailureReason: string | undefined;
    try {
      finalized = await getMintBurnFinalizedHead(chainId, rpcEndpoints, input.budget, input.signal, tronReader);
    } catch (error) {
      throwIfAborted(input.signal);
      if (!tronReader) throw error;
      chainHeadFailureReason = error instanceof TronRpcError ? error.reason : "tron-rpc-read-failed";
    }
    const chainHead = finalized?.number ?? null;
    chainContexts.set(chainId, {
      chainHead,
      ...(chainHeadFailureReason ? { chainHeadFailureReason } : {}),
      rpcEndpoints,
      endpointHeads,
      chainTimestampCache: new Map<string, number>(),
      txContextCache: new Map<string, MintBurnTxContext | null>(),
      ...(tronReader ? { tronReader } : {}),
    });
  }
  return chainContexts;
}
