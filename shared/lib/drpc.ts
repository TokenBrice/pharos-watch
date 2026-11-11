import { DRPC_NETWORK_NAMES } from "../types/chain-identity";

/**
 * Paid dRPC roster for generic readers and pinned research. Chain identity owns
 * the names; this roster stays narrower than the Worker's RPC capabilities.
 */
export const DRPC_NETWORK: Partial<Record<string, string>> = {
  ethereum: DRPC_NETWORK_NAMES.ethereum,
  arbitrum: DRPC_NETWORK_NAMES.arbitrum,
  base: DRPC_NETWORK_NAMES.base,
  optimism: DRPC_NETWORK_NAMES.optimism,
  polygon: DRPC_NETWORK_NAMES.polygon,
  avalanche: DRPC_NETWORK_NAMES.avalanche,
  bsc: DRPC_NETWORK_NAMES.bsc,
  gnosis: DRPC_NETWORK_NAMES.gnosis,
};
