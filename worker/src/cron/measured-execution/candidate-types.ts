// Leaf module (no imports): dex-liquidity/types.ts references this shape, so it
// must not pull in the measured-execution runtime graph, which imports
// dex-liquidity modules back (check:shared-cycles).
export interface UniV3ExecutionCandidate {
  chain: string;
  poolAddress: string;
  feePips: number;
  tvlUsd: number;
  token0Price: number;
  token1Price: number;
  tokens: readonly [
    { address: string; symbol: string; decimals: number },
    { address: string; symbol: string; decimals: number },
  ];
}

export interface SlipstreamExecutionCandidate {
  chain: string;
  poolAddress: string;
  tickSpacing: number;
  tvlUsd: number;
  token0Price: number;
  token1Price: number;
  tokens: readonly [
    { address: string; symbol: string; decimals: number },
    { address: string; symbol: string; decimals: number },
  ];
}

/**
 * Exact PoolKey material indexed from the reviewed Uniswap V4 subgraph
 * schema. Hooked rows stay in the candidate set so target generation can
 * reject an ambiguous token/fee join instead of silently selecting the lone
 * hook-free row.
 */
export interface UniswapV4ExecutionCandidate {
  chain: string;
  poolId: `0x${string}`;
  feePips: number;
  tickSpacing: number;
  hookAddress: `0x${string}`;
  tvlUsd: number;
  token0Price: number;
  token1Price: number;
  tokens: readonly [
    { address: string; symbol: string; decimals: number },
    { address: string; symbol: string; decimals: number },
  ];
}
