import type { ChainRpcConfig } from "../chain-registry";

export function uint256(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function addressWord(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function chainRpcs(chainIds: readonly string[] = ["ethereum"]): Map<string, ChainRpcConfig> {
  return new Map(chainIds.map((chainId) => [chainId, {
    chainId,
    chainName: chainId,
    type: "evm" as const,
    rpcUrl: `https://${chainId}.example`,
    explorerUrl: `https://${chainId}.example/explorer`,
  }]));
}
