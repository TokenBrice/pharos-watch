import { keccak256 } from "viem/utils";
import { fetchEvmStorageAtBlock } from "../../lib/evm-rpc";
import type { EvmMulticall3Result } from "../../lib/evm-rpc";
import { runAdapterIo } from "./concurrency";
import type { AdapterContext } from "./types";
import { normalizeEvmAddress } from "./evm";
import type { requireOnchainInput } from "./input-guards";

type Hex = `0x${string}`;

export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

export function implementationAddressFromSlot(word: Hex | null): string | null {
  if (!word || !/^0x[0-9a-fA-F]{64}$/.test(word)) return null;
  return normalizeEvmAddress(`0x${word.slice(-40)}`);
}

export function runtimeCodeHash(code: Hex | null): string | null {
  return code ? keccak256(code).toLowerCase() : null;
}

export function multicallResultByLabel(
  results: readonly EvmMulticall3Result[],
  label: string,
): Hex | null {
  const result = results.find((candidate) => candidate.label === label);
  return result?.success && result.returnData !== "0x" ? result.returnData : null;
}

/**
 * Reads the EIP-1967 implementation slot at `contractAddress` and decodes the
 * stored address. Throws when the slot read fails or returns a malformed word.
 */
export async function readImplementationSlotAddress(options: {
  adapterKey: string;
  input: ReturnType<typeof requireOnchainInput>;
  contractAddress: string;
  params: { rpcUrl?: string; fallbackRpcUrl?: string };
  signal: AbortSignal;
  ctx?: AdapterContext;
}): Promise<string> {
  const { adapterKey, input, contractAddress, params, signal, ctx } = options;
  const raw = await runAdapterIo(
    ctx,
    `${adapterKey}:implementation-slot`,
    () =>
      fetchEvmStorageAtBlock(input.chain, contractAddress, EIP1967_IMPLEMENTATION_SLOT, "latest", {
        extraRpcUrls: [params.rpcUrl, params.fallbackRpcUrl].filter((url): url is string => url != null),
        signal,
        timeoutMs: 10_000,
        chainRpcs: ctx?.chainRpcs,
      }),
    { signal },
  );
  const implementation = implementationAddressFromSlot(raw);
  if (implementation == null) {
    throw new Error(`${adapterKey}: implementation slot returned malformed payload`);
  }
  return implementation;
}

/**
 * Throws when an observed on-chain address does not equal the reviewed
 * expected address (compared case-insensitively).
 */
export function requireExpectedAddress(adapterKey: string, actual: string, expected: string, label: string): void {
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${adapterKey}: ${label} identity mismatch (${actual} != ${expected.toLowerCase()})`);
  }
}
