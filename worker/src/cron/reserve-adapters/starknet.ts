import { throwIfAborted } from "../../lib/abort";
import type { AdapterContext } from "./types";
import { fetchJsonPostWithRetry } from "./request";

/** starknet_keccak("total_supply"), the Cairo ERC-20 supply entry point. */
const STARKNET_TOTAL_SUPPLY_SELECTOR = "0x1557182e4359a1f0c6301278e8f5b35a776ab58d39892581e357578fb287836";

/**
 * Public Starknet JSON-RPC endpoints, both verified 2026-07-29 to serve
 * `starknet_call` unauthenticated and to agree on the tracked supplies. The
 * historical `blastapi.io` endpoints are permanently retired (HTTP 403).
 */
const STARKNET_RPC_URLS = [
  "https://rpc.starknet.lava.build",
  "https://api.cartridge.gg/x/starknet/mainnet",
] as const;

const FELT_RE = /^0x[0-9a-fA-F]{1,64}$/;

interface StarknetCallResponse {
  result?: unknown;
  error?: { message?: string };
}

/** Recombine a Cairo `u256` returned as `[low, high]` 128-bit felts. */
function parseU256Felts(result: unknown): bigint | null {
  if (!Array.isArray(result) || result.length < 2) return null;
  const [low, high] = result;
  if (typeof low !== "string" || typeof high !== "string") return null;
  if (!FELT_RE.test(low) || !FELT_RE.test(high)) return null;

  const lowValue = BigInt(low);
  const highValue = BigInt(high);
  if (lowValue >= 1n << 128n || highValue >= 1n << 128n) return null;
  return (highValue << 128n) + lowValue;
}

/**
 * Read a Starknet ERC-20 `total_supply()`. Endpoints are tried in order and the
 * last error is rethrown when every one fails, so a curated aggregate leg fails
 * closed with a diagnosable reason rather than silently reading zero.
 */
export async function fetchStarknetTotalSupply(options: {
  contract: string;
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  timeoutMs?: number;
}): Promise<bigint | null> {
  if (!FELT_RE.test(options.contract)) {
    throw new Error(`starknet total_supply probe requires a felt contract address (${options.contract})`);
  }

  const rpcUrls = [options.rpcUrl, options.fallbackRpcUrl, ...STARKNET_RPC_URLS].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );
  let lastError: unknown = null;

  for (const rpcUrl of rpcUrls) {
    throwIfAborted(options.signal);
    try {
      const body = await fetchJsonPostWithRetry<StarknetCallResponse>(
        rpcUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "starknet_call",
          params: {
            request: {
              contract_address: options.contract,
              entry_point_selector: STARKNET_TOTAL_SUPPLY_SELECTOR,
              calldata: [],
            },
            block_id: "latest",
          },
        },
        options.signal,
        options.timeoutMs ?? 10_000,
        options.ctx,
      );

      if (body.error) {
        lastError = new Error(`starknet_call failed on ${rpcUrl}: ${body.error.message ?? "unknown error"}`);
        continue;
      }

      const supply = parseU256Felts(body.result);
      if (supply == null) {
        lastError = new Error(`starknet_call returned an unreadable u256 on ${rpcUrl}`);
        continue;
      }
      return supply;
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (lastError) throw lastError;
  return null;
}
