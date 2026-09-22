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

// Total on purpose: `null` records the reviewed decision that the asset is
// USD-par (native units are USD). A symbol added to BLACKLIST_STABLECOINS
// without a pricing decision here is a compile error, not a silent $1.00.
const BLACKLIST_PRICE_ASSET_IDS: Record<BlacklistStablecoin, string | null> = {
  USDC: null,
  USDT: null,
  PAXG: "paxg-paxos",
  XAUT: "xaut-tether",
  PYUSD: null,
  USD1: null,
  USDG: null,
  RLUSD: null,
  U: null,
  USDTB: null,
  A7A5: "a7a5-old-vector",
  FDUSD: null,
  BRZ: "brz-transfero",
  AUSD: null,
  EURI: "euri-banking-circle",
  USDQ: null,
  USDO: null,
  USDX: null,
  AID: null,
  TGBP: "tgbp-tokenised",
  EURC: "eurc-circle",
  BUIDL: null,
  USDP: null,
  TUSD: null,
  NUSD: null,
  EURCV: "eurcv-societe-generale-forge",
  USDA: null,
  USAT: null,
  AEUR: "aeur-anchored-coins",
  XUSD: null,
  XAUM: "xaum-matrixdock",
  JPYC: "jpyc-jpyc",
  FRXUSD: null,
  FIDD: null,
};

export function getBlacklistPriceAssetId(stablecoin: BlacklistStablecoin): string | null {
  return BLACKLIST_PRICE_ASSET_IDS[stablecoin];
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
