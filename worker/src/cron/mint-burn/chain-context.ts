import { buildAlchemyUrl, getAlchemyBlockNumber } from "../../lib/alchemy-logs";
import type { MintBurnTxContext } from "../../lib/mint-burn-bridge-classifier";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";

export interface MintBurnChainContext {
  chainHead: number;
  alchemyUrl: string;
  chainTimestampCache: Map<number, number>;
  txContextCache: Map<string, MintBurnTxContext | null>;
}

export async function loadMintBurnChainContexts(input: {
  configs: MintBurnContractConfig[];
  apiKey: string;
  budget: { limit: number; count: number };
  signal?: AbortSignal;
}): Promise<Map<string, MintBurnChainContext>> {
  const chainContexts = new Map<string, MintBurnChainContext>();
  for (const chainId of [...new Set(input.configs.map((config) => config.chain.chainId))]) {
    const alchemyUrl = buildAlchemyUrl(chainId, input.apiKey);
    if (!alchemyUrl) {
      throw new Error(`Failed to build ${chainId} Alchemy URL`);
    }
    const chainHead = await getAlchemyBlockNumber(alchemyUrl, input.budget, input.signal);
    if (chainHead === null) {
      throw new Error(`Failed to get ${chainId} chain head`);
    }
    chainContexts.set(chainId, {
      chainHead,
      alchemyUrl,
      chainTimestampCache: new Map<number, number>(),
      txContextCache: new Map<string, MintBurnTxContext | null>(),
    });
  }
  return chainContexts;
}
