export const DEWS_SIGNAL_WEIGHTS = {
  supply: 0.25,
  pool: 0.2,
  liq: 0.15,
  price: 0.15,
  diverg: 0.15,
  black: 0.1,
  flow: 0.1,
  yield: 0.05,
} as const;

export type DewsSignalKey = keyof typeof DEWS_SIGNAL_WEIGHTS;

export const DEWS_SIGNAL_LABELS: Record<DewsSignalKey, string> = {
  supply: "Supply Velocity",
  pool: "Pool Balance Drift",
  liq: "Liquidity Erosion",
  price: "Price Confidence",
  diverg: "Cross-Source Divergence",
  black: "Blacklist Activity",
  flow: "Mint/Burn Flow",
  yield: "Yield Anomaly",
};

export const DEWS_SIGNAL_SHORT_LABELS: Record<DewsSignalKey, string> = {
  ...DEWS_SIGNAL_LABELS,
  diverg: "Cross-Source Div.",
};

export const DEWS_SIGNAL_DESCRIPTIONS: Record<DewsSignalKey, string> = {
  supply: "rapid redemptions (bank run), measured from 1-day and 7-day supply contraction rates",
  pool: "one-sided selling pressure in DEX pools, blending balance stress, pool stress, and worst-pool imbalance",
  liq: "LPs fleeing, measured from 7-day changes in liquidity score and TVL",
  price: "N-source consensus failures across CoinGecko, DefiLlama list, GeckoTerminal, Binance, Coinbase, RedStone, Curve on-chain, and DEX prices; maps confidence levels (high/single-source/low/fallback) to stress values",
  diverg: "fragmented pricing between multi-source consensus price, DEX price, and peg reference",
  black: "issuer emergency freeze surges for canonical stablecoin IDs with direct blacklist-tracker coverage",
  flow: "redemption surge vs minting from on-chain Transfer event data; requires at least 7 baseline days and a fresh 24-hour mint/burn row, with fresh zero-volume rows contributing zero flow stress",
  yield: "warning-signal and structured source-risk accumulation from yield spikes, divergence, TVL outflows, negative trends, reward-heavy regimes, thin/stale sources, source switches, and source-risk rank drivers",
};

export const DEWS_THREAT_BANDS = [
  { upper: 15, band: "CALM" },
  { upper: 35, band: "WATCH" },
  { upper: 55, band: "ALERT" },
  { upper: 75, band: "WARNING" },
  { upper: 100, band: "DANGER" },
] as const;
