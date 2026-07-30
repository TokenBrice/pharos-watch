import type { EvmMulticall3Result } from "../../lib/evm-rpc";
import { keccak256 } from "viem/utils";
import { normalizeEvmAddress } from "./evm";

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
