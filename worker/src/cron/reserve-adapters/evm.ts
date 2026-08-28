import type { StablecoinMeta } from "@shared/types/core";
export { normalizeEvmAddress } from "../../lib/evm-selectors";

export function parseEvmAddressResult(result: `0x${string}`): string | null {
  return /^0x[0-9a-fA-F]{64}$/.test(result)
    ? `0x${result.slice(-40).toLowerCase()}`
    : null;
}

/**
 * Trim, lowercase, and validate an EVM address. Returns `null` for missing or
 * malformed input. Callers needing a throwing variant should wrap this.
 */
export function resolveCoinContractAddress(
  coin: StablecoinMeta,
  chainId: string,
): string | null {
  const contract = coin.contracts?.find((entry) => entry.chain === chainId);
  return contract?.address ?? null;
}
