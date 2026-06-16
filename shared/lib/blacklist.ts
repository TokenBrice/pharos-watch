import {
  BLACKLIST_STABLECOINS,
  type BlacklistAmountStatus,
  type BlacklistStablecoin,
} from "../types/market";

const BLACKLIST_STABLECOIN_SET: ReadonlySet<string> = new Set(BLACKLIST_STABLECOINS);

export function isBlacklistStablecoin(value: string): value is BlacklistStablecoin {
  return BLACKLIST_STABLECOIN_SET.has(value);
}

export function isGoldBlacklistStablecoin(symbol: string): symbol is "PAXG" | "XAUT" | "XAUM" {
  return symbol === "PAXG" || symbol === "XAUT" || symbol === "XAUM";
}

const BLACKLIST_PRICE_ASSET_IDS: Partial<Record<BlacklistStablecoin, string>> = {
  PAXG: "paxg-paxos",
  XAUT: "xaut-tether",
  XAUM: "xaum-matrixdock",
  A7A5: "a7a5-old-vector",
  BRZ: "brz-transfero",
  EURC: "eurc-circle",
  EURI: "euri-banking-circle",
  EURCV: "eurcv-societe-generale-forge",
  AEUR: "aeur-anchored-coins",
  TGBP: "tgbp-tokenised",
  JPYC: "jpyc-jpyc",
};

export function getBlacklistPriceAssetId(stablecoin: BlacklistStablecoin): string | null {
  return BLACKLIST_PRICE_ASSET_IDS[stablecoin] ?? null;
}

export function computeBlacklistAmountUsdAtEvent(
  stablecoin: BlacklistStablecoin,
  amountNative: number | null,
  assetPriceUsd?: number | null,
): number | null {
  if (amountNative == null) return null;
  if (!getBlacklistPriceAssetId(stablecoin)) return amountNative;
  return assetPriceUsd ? amountNative * assetPriceUsd : null;
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

export function buildBlacklistContractBalanceKey(
  stablecoin: BlacklistStablecoin,
  chainId: string,
  address: string,
  configKey?: string | null,
  contractAddress?: string | null,
): string {
  const legacyKey = buildBlacklistAddressCountKey(stablecoin, chainId, address);
  const normalizedConfigKey = configKey?.trim().toLowerCase() || null;
  const normalizedContractAddress = contractAddress?.trim().toLowerCase() || null;
  if (!normalizedConfigKey && !normalizedContractAddress) return legacyKey;
  return [
    stablecoin,
    chainId,
    normalizedContractAddress ?? "unknown-contract",
    normalizedConfigKey ?? "unknown-config",
    address.toLowerCase(),
  ].join(":");
}
