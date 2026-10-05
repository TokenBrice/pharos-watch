/** Known TRON transports, including URL-only measurement callers. Chain-aware
 * callers must also check chainId/config type: a custom host is not discoverable.
 */
export function isTronRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "trongrid.io" || parsed.hostname.endsWith(".trongrid.io") ||
      parsed.hostname === "tron-mainnet.g.alchemy.com" ||
      parsed.searchParams.get("network") === "tron";
  } catch {
    return false;
  }
}

/** TRON eth_call objects verify block existence, NOT historical state.
 * Storage/code/balance reads likewise have no admitted historical state path.
 * Block headers and historical logs are not state reads and remain available.
 * https://developers.tron.network/reference/eth_call (2026-09-08)
 */
export function requiresHistoricalEvmState(method: string, params: readonly unknown[]): boolean {
  let selector: unknown;
  switch (method) {
    case "eth_call":
    case "eth_getCode":
    case "eth_getBalance":
    case "eth_getTransactionCount":
      selector = params[1];
      break;
    case "eth_getStorageAt":
    case "eth_getProof":
      selector = params[2];
      break;
    default:
      return false;
  }
  return selector !== undefined && selector !== "latest";
}
