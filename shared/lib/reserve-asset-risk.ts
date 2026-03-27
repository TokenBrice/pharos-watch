import type { ReserveRisk } from "../types";

export const CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL = {
  // ── Very-low: no/minimal counterparty risk ─────────────────
  ETH: "very-low",
  WETH: "very-low",

  // ── Low: stablecoin / tokenized layer ──────────────────────
  USDC: "low",
  USDT: "low",
  DAI: "low",
  USDS: "low",
  LUSD: "low",
  BOLD: "low",
  ZCHF: "low",
  DEURO: "low",
  FRAX: "low",
  FRXUSD: "low",
  PYUSD: "low",
  GHO: "low",
  DOLA: "low",
  AUSD: "low",
  TUSD: "low",
  GUSD: "low",
  STETH: "low",
  WSTETH: "low",
  RETH: "low",
  WEETH: "low",
  SFRXETH: "low",
  LSETH: "low",
  BUIDL: "low",
  USTB: "low",
  USYC: "low",

  // ── Medium: wrapped / structured / centralized-custody ─────
  BTC: "medium",
  WBTC: "medium",
  CBBTC: "medium",
  KBTC: "medium",
  LBTC: "medium",
  TBTC: "medium",
  ZKBTC: "medium",
  SOLVBTC: "medium",
  BTCB: "medium",
  PAXG: "medium",
  XAUT: "medium",

  // ── High: volatile native assets ───────────────────────────
  SOL: "high",
  BNB: "high",
  TRX: "high",
  HYPE: "high",
  CELO: "high",
  POL: "high",

  // ── Very-high: governance / exotic ─────────────────────────
  DEPS: "very-high",
  CRV: "very-high",
  GNO: "very-high",
  UNI: "very-high",
} as const satisfies Record<string, ReserveRisk>;

export const CANONICAL_ETH_RESERVE_RISK = CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL.ETH;
export const CANONICAL_WETH_RESERVE_RISK = CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL.WETH;

export function getCanonicalReserveAssetRisk(symbol: string): ReserveRisk | null {
  const normalized = symbol.trim().toUpperCase();
  const risk = (CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL as Record<string, ReserveRisk | undefined>)[normalized];
  return risk ?? null;
}
