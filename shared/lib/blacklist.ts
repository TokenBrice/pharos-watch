import type {
  BlacklistAmountStatus,
  BlacklistStablecoin,
} from "../types/market";

export function isGoldBlacklistStablecoin(symbol: string): symbol is "PAXG" | "XAUT" {
  return symbol === "PAXG" || symbol === "XAUT";
}

export function computeBlacklistAmountUsdAtEvent(
  stablecoin: BlacklistStablecoin,
  amountNative: number | null,
  goldPriceUsd?: number | null,
): number | null {
  if (amountNative == null) return null;
  if (!isGoldBlacklistStablecoin(stablecoin)) return amountNative;
  return goldPriceUsd ? amountNative * goldPriceUsd : null;
}

export function isBlacklistAmountGapStatus(status: BlacklistAmountStatus): boolean {
  return status === "recoverable_pending" || status === "provider_failed" || status === "ambiguous";
}

export type BlacklistAddressCountMode =
  | "address"
  | "address-chain"
  | "address-chain-stablecoin";

export function buildBlacklistAddressCountKey(
  stablecoin: BlacklistStablecoin,
  chainId: string,
  address: string,
  mode: BlacklistAddressCountMode = "address-chain-stablecoin",
): string {
  if (mode === "address") return address.toLowerCase();
  if (mode === "address-chain") return `${chainId}:${address.toLowerCase()}`;
  return `${stablecoin}:${chainId}:${address.toLowerCase()}`;
}
