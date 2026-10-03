import { keccak256 } from "viem/utils";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmRpcBatch } from "../evm-rpc";
import { throwIfAborted } from "../abort";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import type { LivePriceContext } from "./helpers";

/** Pin fresh Ethereum state and verify reviewed deployments before reading quotes. */
export async function fetchPinnedEthereumRuntime(
  context: LivePriceContext,
  reviewedRuntime: readonly (readonly [string, string])[],
  reject: (reason: string) => null,
  signal?: AbortSignal,
) {
  const options = { signal, chainRpcs: context.chainRpcs, extraRpcUrls: getPublicFallbackRpcUrls("ethereum"), maxRetries: 0 };
  const block = await fetchEvmBlockNumber("ethereum", options);
  if (block == null) return reject("block-unavailable");
  const head = await fetchEvmBlockHeader("ethereum", block, options);
  const now = Math.floor(Date.now() / 1000);
  if (!head || head.timestamp > now || now - head.timestamp >= 300) return reject("block-age");
  const tag = `0x${block.toString(16)}`;
  // Serial, body-consumed RPC batches occupy one connection per authoritative lane.
  const codes = await fetchEvmRpcBatch("ethereum", reviewedRuntime.map(([address]) => ({ method: "eth_getCode", params: [address, tag] })), options);
  throwIfAborted(signal);
  if (!codes || codes.length !== reviewedRuntime.length || codes.some((code, i) =>
    typeof code !== "string" || code.length % 2 !== 0 || !/^0x[0-9a-fA-F]+$/.test(code) ||
    keccak256(code as `0x${string}`) !== reviewedRuntime[i][1])) return reject("runtime-code");
  return { options, block, head, tag };
}
