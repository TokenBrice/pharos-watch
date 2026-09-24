import type { ChainRpcConfig, RpcEndpoint, RpcOperator } from "../lib/chain-registry";

/**
 * Shared `ChainRpcConfig` fixtures for source and observer tests.
 *
 * Registry endpoints carry today's registry behaviour — archive state, full log
 * history, and `keyed` mirroring the operator — so callers exercise the exact
 * URL lists the sources derive through `registryRpcUrls`. Supplemental
 * (Dwellir) endpoints are deliberately absent: a test that needs one appends it
 * itself.
 */

export function registryRpcEndpoint(url: string, operator: RpcOperator = "public"): RpcEndpoint {
  return {
    url,
    operator,
    keyed: operator !== "public",
    position: "registry",
    stateHistory: "archive",
    logsHistory: "full",
  };
}

/**
 * Registry-only EVM config. `rpcUrls` keep their order, so index 0 is the
 * chain's primary URL and index 1 its fallback.
 */
export function makeChainRpcConfig(params: {
  chainId: string;
  rpcUrls: readonly string[];
  chainName?: string;
  explorerUrl?: string;
}): ChainRpcConfig {
  return {
    chainId: params.chainId,
    chainName: params.chainName ?? params.chainId,
    type: "evm",
    endpoints: params.rpcUrls.map((url) => registryRpcEndpoint(url)),
    explorerUrl: params.explorerUrl ?? `https://${params.chainId}.example/explorer`,
  };
}

/** One `https://<chainId>.example` registry endpoint per chain, keyed by chain id. */
export function makeChainRpcs(chainIds: readonly string[]): Map<string, ChainRpcConfig> {
  return new Map(chainIds.map((chainId): [string, ChainRpcConfig] => [
    chainId,
    makeChainRpcConfig({ chainId, rpcUrls: [`https://${chainId}.example`] }),
  ]));
}
