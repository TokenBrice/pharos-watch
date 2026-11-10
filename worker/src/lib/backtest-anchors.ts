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
  /** Short operator note describing how the timestamp/peak was verified. */
  verificationNote: string;
  /** Public source URLs or API URLs used for verification. */
  sourceUrls: readonly string[];
}

export interface BacktestNegativeControl {
  stablecoinId: string;
  windowStart: number;
  windowEnd: number;
  description: string;
  verificationNote: string;
  sourceUrls: readonly string[];
}

/**
 * Curated set of reference depeg events used for backtest precision / recall.
 * Each anchor must be independently verifiable against the depeg_events table
 * at https://api.pharos.watch/api/depeg-events?stablecoin=<id>.
 *
 * Scope: only DEWS-era events whose full pre-onset lookback window sits inside
 * stress_signal_history are included, so every anchor can actually be scored.
 * The table starts at the DEWS v4.0 launch (2026-03-01), so an onset needs its
 * whole lookback after that date. Pre-DEWS events (USDC SVB 2023, historical
 * USDT stress) remain relevant history but cannot score precision/recall
 * without DEWS coverage.
 *
 * Keep the list small (< 15). Only include events with a clear onset,
 * resolution, and >= 200 bps peak magnitude — noisy micro-depegs belong in
 * the live pipeline, not the backtest fixture.
 */
export const DEWS_HISTORY_START_SEC = 1_772_323_200; // 2026-03-01T00:00:00Z

export const BACKTEST_ANCHORS: readonly BacktestAnchor[] = Object.freeze([
  {
    stablecoinId: "uty-xsy",
    onsetAt: 1775963092, // 2026-04-12 03:04:52 UTC
    resolvedAt: 1775981076, // 2026-04-12 08:04:36 UTC
    peakAbsBps: 287,
    description: "UTY mid-April upward deviation (+287 bps)",
    verificationNote: "Verified against live Pharos /api/depeg-events row on 2026-04-18.",
    sourceUrls: ["https://api.pharos.watch/api/depeg-events?stablecoin=uty-xsy&limit=100"],
  },
  {
    stablecoinId: "meusd-mezo",
    onsetAt: 1776124175, // 2026-04-13 23:49:35 UTC
    resolvedAt: 1776281649, // 2026-04-15 19:34:09 UTC
    peakAbsBps: 591,
    description: "MEUSD April sustained depeg (+591 bps)",
    verificationNote: "Verified against live Pharos /api/depeg-events row on 2026-04-18.",
    sourceUrls: ["https://api.pharos.watch/api/depeg-events?stablecoin=meusd-mezo&limit=100"],
  },
]);

/**
 * Negative controls intentionally start empty until each calm window is verified
 * against both depeg_events absence and available stress_signal_history coverage.
 * Tests reject placeholder entries so calibration does not invent calm windows.
 */
export const BACKTEST_NEGATIVE_CONTROLS: readonly BacktestNegativeControl[] = Object.freeze([]);
