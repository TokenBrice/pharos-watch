/** Reviewed native read surfaces; URLs never contain credentials. */
export const DWELLIR_NATIVE_ENDPOINTS = [
  {
    network: "aptos",
    baseUrl: "https://api-aptos-mainnet.n.dwellir.com/v1",
    protocol: "aptos-rest",
    expectedChainId: 1,
    requiresRetainedLedgerFloor: false,
  },
  {
    network: "movement",
    baseUrl: "https://api-movement-mainnet.n.dwellir.com/v1",
    protocol: "aptos-rest",
    expectedChainId: 126,
    // Full node: retained ledger state only, not an archive entitlement.
    requiresRetainedLedgerFloor: true,
  },
  {
    network: "tron",
    baseUrl: "https://api-tron-mainnet.n.dwellir.com",
    protocol: "tron-http",
    allowedPath: "/wallet/triggerconstantcontract",
  },
  {
    network: "starknet",
    baseUrl: "https://api-starknet-mainnet.n.dwellir.com",
    protocol: "starknet-jsonrpc",
    allowedMethod: "starknet_call",
  },
] as const;

export type DwellirNativeEndpoint = (typeof DWELLIR_NATIVE_ENDPOINTS)[number];
export type DwellirNativeNetwork = DwellirNativeEndpoint["network"];
