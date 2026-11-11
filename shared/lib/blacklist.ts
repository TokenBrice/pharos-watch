import {
  BLACKLIST_STABLECOINS,
  type BlacklistAmountStatus,
  type BlacklistStablecoin,
} from "../types/blacklist";
import { canonicalBlacklistAddress } from "./tron-address";

const BLACKLIST_STABLECOIN_SET: ReadonlySet<string> = new Set(BLACKLIST_STABLECOINS);

export function isBlacklistStablecoin(value: string): value is BlacklistStablecoin {
  return BLACKLIST_STABLECOIN_SET.has(value);
}

// Total on purpose: `null` records the reviewed USD-par pricing decision.
// Commodity units own the native display precision alongside that identity.
const BLACKLIST_ASSETS: Record<BlacklistStablecoin, { priceAssetId: string | null; commodity: "gold" | null }> = {
  USDC: { priceAssetId: null, commodity: null },
  USDT: { priceAssetId: null, commodity: null },
  PAXG: { priceAssetId: "paxg-paxos", commodity: "gold" },
  XAUT: { priceAssetId: "xaut-tether", commodity: "gold" },
  PYUSD: { priceAssetId: null, commodity: null },
  USD1: { priceAssetId: null, commodity: null },
  USDG: { priceAssetId: null, commodity: null },
  RLUSD: { priceAssetId: null, commodity: null },
  U: { priceAssetId: null, commodity: null },
  USDTB: { priceAssetId: null, commodity: null },
  A7A5: { priceAssetId: "a7a5-old-vector", commodity: null },
  FDUSD: { priceAssetId: null, commodity: null },
  BRZ: { priceAssetId: "brz-transfero", commodity: null },
  AUSD: { priceAssetId: null, commodity: null },
  EURI: { priceAssetId: "euri-banking-circle", commodity: null },
  USDQ: { priceAssetId: null, commodity: null },
  USDO: { priceAssetId: null, commodity: null },
  USDX: { priceAssetId: null, commodity: null },
  AID: { priceAssetId: null, commodity: null },
  TGBP: { priceAssetId: "tgbp-tokenised", commodity: null },
  EURC: { priceAssetId: "eurc-circle", commodity: null },
  BUIDL: { priceAssetId: null, commodity: null },
  USDP: { priceAssetId: null, commodity: null },
  TUSD: { priceAssetId: null, commodity: null },
  NUSD: { priceAssetId: null, commodity: null },
  EURCV: { priceAssetId: "eurcv-societe-generale-forge", commodity: null },
  USDA: { priceAssetId: null, commodity: null },
  USAT: { priceAssetId: null, commodity: null },
  AEUR: { priceAssetId: "aeur-anchored-coins", commodity: null },
  XUSD: { priceAssetId: null, commodity: null },
  XAUM: { priceAssetId: "xaum-matrixdock", commodity: "gold" },
  JPYC: { priceAssetId: "jpyc-jpyc", commodity: null },
  FRXUSD: { priceAssetId: null, commodity: null },
  FIDD: { priceAssetId: null, commodity: null },
};

export function isGoldBlacklistStablecoin(symbol: string): symbol is "PAXG" | "XAUT" | "XAUM" {
  return isBlacklistStablecoin(symbol) && BLACKLIST_ASSETS[symbol].commodity === "gold";
}

export function getBlacklistNativeFractionDigits(stablecoin: BlacklistStablecoin): 2 | 4 {
  return BLACKLIST_ASSETS[stablecoin].commodity === "gold" ? 4 : 2;
}

export function getBlacklistPriceAssetId(stablecoin: BlacklistStablecoin): string | null {
  return BLACKLIST_ASSETS[stablecoin].priceAssetId;
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
  const identity = canonicalBlacklistAddress(chainId, address);
  if (mode === "address") return identity;
  if (mode === "address-chain") return `${chainId}:${identity}`;
  return `${stablecoin}:${chainId}:${identity}`;
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
    canonicalBlacklistAddress(chainId, address),
  ].join(":");
}
