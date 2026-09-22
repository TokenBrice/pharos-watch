import type { StablecoinMeta } from "@shared/types/core";
export { normalizeEvmAddress } from "../../lib/evm-selectors";


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
