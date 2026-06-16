/**
 * Canonical dRPC network name map: chain-registry chainId → dRPC network slug.
 * Authoritative source for all dRPC URL construction; both balance-providers
 * and chainlink-feeds import from here so adding a chain only requires one edit.
 */
export const DRPC_NETWORK: Partial<Record<string, string>> = {
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  bsc: "bsc",
  gnosis: "gnosis",
};
