/** HyperEVM history verified 2026-11-06; public latest-only routes ignore selectors (#1913). */
export const HYPEREVM_HISTORY_RPC_URL = "https://hyperliquid.drpc.org";

const LATEST_ONLY_RPC_ENDPOINTS = new Set([
  "https://rpc.hyperliquid.xyz/evm",
  "https://rpc.hypurrscan.io",
]);

/** Apply even to caller-supplied URLs, independently of registry endpoint metadata. */
export function supportsEvmRpcBlockSelectors(url: string): boolean {
  try {
    const parsed = new URL(url);
    return !LATEST_ONLY_RPC_ENDPOINTS.has(`${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`);
  } catch {
    return false;
  }
}
