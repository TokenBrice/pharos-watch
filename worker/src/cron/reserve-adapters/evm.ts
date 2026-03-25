import type { StablecoinMeta } from "@shared/types/core";

export function parseEvmAddressResult(result: `0x${string}`): string | null {
  return /^0x[0-9a-fA-F]{64}$/.test(result)
    ? `0x${result.slice(-40).toLowerCase()}`
    : null;
}

export function resolveCoinContractAddress(
  coin: StablecoinMeta,
  chainId: string,
): string | null {
  const contract = coin.contracts?.find((entry) => entry.chain === chainId);
  return contract?.address ?? null;
}
