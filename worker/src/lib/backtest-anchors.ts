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
 * Scope: only DEWS-era events (post-2026-03-01 when DEWS v4.0 launched) are
 * included so the backtest harness has stress_signal_history rows to compare
 * against. Pre-DEWS events (USDC SVB 2023, historical USDT stress) remain
 * relevant history but cannot score precision/recall without DEWS coverage.
 *
 * Keep the list small (< 15). Only include events with a clear onset,
 * resolution, and >= 200 bps peak magnitude — noisy micro-depegs belong in
 * the live pipeline, not the backtest fixture.
 */
export const BACKTEST_ANCHORS: readonly BacktestAnchor[] = Object.freeze([
  {
    stablecoinId: "usdx-hex-trust",
    onsetAt: 1772493358, // 2026-03-02 23:15:58 UTC
    resolvedAt: 1772506873, // 2026-03-03 03:01:13 UTC
    peakAbsBps: 3101,
    description: "USDX severe early-March stress (-3101 bps)",
    verificationNote: "Verified against live Pharos /api/depeg-events row on 2026-04-18.",
    sourceUrls: ["https://api.pharos.watch/api/depeg-events?stablecoin=usdx-hex-trust&limit=100"],
  },
  {
    stablecoinId: "meusd-mezo",
    onsetAt: 1773291658, // 2026-03-12 05:00:58 UTC
    resolvedAt: 1773294353, // 2026-03-12 05:45:53 UTC
    peakAbsBps: 296,
    description: "MEUSD mid-March brief depeg (-296 bps)",
    verificationNote: "Verified against live Pharos /api/depeg-events row on 2026-04-18.",
    sourceUrls: ["https://api.pharos.watch/api/depeg-events?stablecoin=meusd-mezo&limit=100"],
  },
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

/**
 * Flip to `true` once every BACKTEST_ANCHORS entry has been verified against the live
 * /api/depeg-events response. Leaving this false causes the test below to fail, blocking a
 * merge of placeholder timestamps.
 *
 * Verified on 2026-04-18 via `api.pharos.watch/api/depeg-events?stablecoin=<id>&limit=100`
 * using PHAROS_API_KEY auth. All four onset/resolved pairs and peakAbsBps values match the
 * live stored rows within rounding.
 */
export const BACKTEST_ANCHORS_VERIFIED = true;
