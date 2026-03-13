import type { ReserveRisk } from "../types";

export const CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL = {
  USDC: "low",
  DAI: "low",
  LUSD: "low",
  ZCHF: "low",
  DEURO: "low",
  DEPS: "very-high",
  BTC: "medium",
  WBTC: "medium",
  CBBTC: "medium",
  KBTC: "medium",
  LBTC: "medium",
  TBTC: "medium",
  ZKBTC: "medium",
  ETH: "very-low",
  WETH: "very-low",
  STETH: "low",
  WSTETH: "low",
  RETH: "low",
  WEETH: "low",
  SFRXETH: "low",
  LSETH: "low",
  PAXG: "medium",
  XAUT: "medium",
} as const satisfies Record<string, ReserveRisk>;

export const CANONICAL_ETH_RESERVE_RISK = CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL.ETH;
export const CANONICAL_WETH_RESERVE_RISK = CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL.WETH;

export function getCanonicalReserveAssetRisk(symbol: string): ReserveRisk | null {
  const normalized = symbol.trim().toUpperCase();
  const risk = CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL[
    normalized as keyof typeof CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL
  ];
  return risk ?? null;
}
