export interface BacktestAnchor {
  /** Stablecoin ID (matches depeg_events.stablecoin_id). */
  stablecoinId: string;
  /** Unix seconds: canonical "onset" timestamp. */
  onsetAt: number;
  /** Unix seconds: canonical "resolved" timestamp (null = never fully resolved). */
  resolvedAt: number | null;
  /** Peak absolute bps reached. */
  peakAbsBps: number;
  /** One-line description used in reports. */
  description: string;
}

/**
 * Curated set of reference depeg events used for backtest precision / recall.
 * Each anchor must be independently verifiable against the depeg_events table
 * at https://api.pharos.watch/api/depeg-events?stablecoin=<id>.
 *
 * Keep the list small (< 15) and only include events that have a clear,
 * undisputed onset and resolution — noisy micro-depegs belong in the live
 * pipeline, not the backtest fixture.
 */
export const BACKTEST_ANCHORS: readonly BacktestAnchor[] = Object.freeze([
  {
    stablecoinId: "usdc-usd-coin",
    onsetAt: 1678492800, // 2023-03-11
    resolvedAt: 1678752000, // 2023-03-14
    peakAbsBps: 1200,
    description: "USDC Silicon Valley Bank exposure",
  },
  {
    stablecoinId: "usdt-tether",
    onsetAt: 1697544000, // 2023-10-17 (illustrative; confirm against history)
    resolvedAt: 1697632800,
    peakAbsBps: 140,
    description: "USDT CEX imbalance, late 2023",
  },
  {
    stablecoinId: "fdusd-first-digital-usd",
    onsetAt: 1730332800, // 2024-10-31 (illustrative; confirm)
    resolvedAt: 1730419200,
    peakAbsBps: 250,
    description: "FDUSD Binance custody wobble",
  },
  {
    stablecoinId: "busd-binance-usd",
    onsetAt: 1707782400, // 2024-02-13 wind-down residual
    resolvedAt: null,
    peakAbsBps: 180,
    description: "BUSD wind-down residual",
  },
]);

/**
 * Flip to `true` once every BACKTEST_ANCHORS entry has been verified against the live
 * /api/depeg-events response. Leaving this false causes the test below to fail, blocking a
 * merge of placeholder timestamps.
 */
export const BACKTEST_ANCHORS_VERIFIED = false;
