import type { StablecoinMeta } from "@shared/types/core";
export { normalizeEvmAddress } from "../../lib/evm-selectors";


/**
 * Resolve the coin's configured contract address on `chainId`. Returns `null`
 * when the coin declares no contract for that chain.
 */
export function resolveCoinContractAddress(
  coin: StablecoinMeta,
  chainId: string,
): string | null {
  const contract = coin.contracts?.find((entry) => entry.chain === chainId);
  return contract?.address ?? null;
}
