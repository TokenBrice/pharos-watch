import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_DEWS_V6: readonly MethodologyChangelogEntry[] = [
  {
    version: "6.08",
    title: "Display surfaces share the peg-reference authority gate",
    date: "2026-06-10",
    effectiveAt: 1781049600,
    summary:
      "Displayed peg deviation now uses the same peg-reference authority gate as the depeg detection engine: thin non-USD peer groups without a live FX fallback show 'reference unavailable' instead of a self-referential ~0 deviation.",
    impact: [
      "A lone non-USD coin's peer-median reference equals its own price (deviation always ~0) and a 2-coin group mirrors half of any real move onto the healthy peer; detection has always failed closed on these, but peg-summary, the depeg tracker, and the coin-detail hero kept publishing the masked number",
      "When the gate fails, currentDeviationBps is withheld (null) and the new pegReferenceUnavailable flag drives an explicit 'reference unavailable' readout in the tracker table and detail hero",
      "USD, commodity, VAR/OTHER pegs and groups with a live FX fallback or at least 3 peer contributors are unaffected",
      "Depeg detection, PegScore, and event history are unchanged — this aligns the displayed numbers with the detection engine's existing trust policy",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.07",
    title: "Medium venue-risk yield anomaly branch",
    date: "2026-06-09",
    effectiveAt: 1780966800,
    summary:
      "DEWS now treats reviewed medium-risk yield venues as a bounded structured Yield Anomaly input while preserving the stronger high-risk venue branch.",
    impact: [
      "Structured Yield Intelligence evidence with `sourceRisk.venueRiskTier = \"medium\"` now adds +10 to the Yield Anomaly sub-signal",
      "Medium venue-risk rows emit the `structured-medium-risk-venue` warning",
      "The existing high-risk venue branch remains +25 with `structured-high-risk-venue`",
      "The final Yield Anomaly sub-signal still caps at 100 after adding warning-string, source-risk, and rank-attribution evidence",
      "Missing, malformed, unknown, low, or otherwise neutral venue-risk evidence remains a no-op and does not create an available zero-stress yield signal",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.06",
    title: "Confirmation peg-reference parity and directional duplicate repair",
    date: "2026-06-06",
    effectiveAt: 1780758000,
    summary:
      "Pending depeg confirmation now reuses the live detection peg-reference authority gate, and duplicate open-event repair no longer folds opposite-direction peaks into a surviving row.",
    impact: [
      "Thin non-USD fiat peg references without FX fallback use the stored pending `peg_reference` when valid instead of recomputing confirmation against a 1-2 coin peer median",
      "Pending rows with neither an authoritative refreshed reference nor a valid stored reference wait for a safer reference instead of being deleted or promoted",
      "Duplicate open-event repair merges only same-direction rows and closes older opposite-direction rows at the newer direction boundary with `recovery_price = NULL`",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.05",
    title: "Missing supply anchors fail closed",
    date: "2026-06-06",
    effectiveAt: 1780755099,
    summary:
      "DEWS now marks the Supply Velocity sub-signal unavailable when both previous-day and previous-week supply-history anchors are absent.",
    impact: [
      "Coins with no prior supply-history anchors no longer receive an available zero-stress supply signal by default",
      "When only one prior anchor is present, DEWS still computes the available side and treats the missing side as zero velocity contribution",
      "Explicit finite zero anchors remain available and continue to produce zero velocity stress instead of divide-by-zero behavior",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.04",
    title: "Below-floor live event closure",
    date: "2026-06-06",
    effectiveAt: 1780755098,
    summary:
      "Live depeg detection now closes an already-open event when the tracked asset remains in the cache but falls below the $1M live-event supply floor.",
    impact: [
      "A coin that depegged above the live-event floor no longer stays LIVE forever after supply shrinks below $1M",
      "Below-floor closures keep `recovery_price = NULL`, matching other coverage-lost closures where Pharos cannot assert a price recovery",
      "New below-floor coins still cannot open fresh live depeg rows; the change only resolves existing open rows whose coverage leaves the live-event universe",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.03",
    title: "Blacklist activity stablecoin-id attribution",
    date: "2026-06-06",
    effectiveAt: 1780753058,
    summary:
      "DEWS blacklist activity now resolves recent blacklist events to the tracker config's canonical stablecoin id before scoring.",
    impact: [
      "Blacklist counts are hydrated from event provenance (`config_key` / `contract_address`) instead of being grouped by bare symbol",
      "Same-symbol siblings that do not have direct blacklist-tracker coverage now keep the blacklist sub-signal unavailable",
      "Legacy event rows without provenance fall back only to a single tracker-owned stablecoin id for that symbol, avoiding fan-out across same-symbol PSI assets",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.02",
    title: "Explicit zero supply-history anchors",
    date: "2026-06-05",
    effectiveAt: 1780617600,
    summary:
      "DEWS now preserves explicit zero previous-day and previous-week supply-history anchors instead of treating them as missing current-supply fallbacks.",
    impact: [
      "Absent previous-day or previous-week supply history still defaults to the current supply so new or incomplete rows do not create false contraction",
      "Finite zero buckets in the stablecoins cache now remain zero when the supply-velocity input is assembled",
      "The supply sub-signal continues to treat zero baselines as zero velocity stress, avoiding divide-by-zero while keeping the input provenance explicit",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.01",
    title: "Priced-observation PegScore anchors",
    date: "2026-06-03",
    effectiveAt: 1780444800,
    summary:
      "PegScore tracking windows can now anchor from the first durable Pharos price observation when supply-history coverage is absent, so priced non-NAV assets no longer remain unrated solely because they have not written a supply snapshot.",
    impact: [
      "Curated launch dates remain the preferred tracking anchor, followed by the earliest supply_history snapshot",
      "For priced assets without either anchor, the stablecoins cache now contributes a durable first-observed valid-price timestamp through the same first-seen cache used by PegScore",
      "Newly observed priced assets still need at least 7 days of tracking before PegScore is rated; missing-price assets and pure NAV tokens remain NR",
      "Low-cap assets below the live depeg-event floor can receive a PegScore anchor, while the existing coverage-limited flag continues to warn that empty event history is not full depeg coverage",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.0",
    title: "Historical provenance, quality-aware PegScore, and calibration metrics",
    date: "2026-05-14",
    effectiveAt: 1778716800,
    summary:
      "Depeg history now records durable replay/audit provenance, PegScore discounts weak or disputed historical rows, and DEWS backtests report calibration metrics from stored stress-signal history.",
    impact: [
      "Backfill runs persist replay status, counts, fingerprints, source providers, quote mode, peg-reference/supply source, confidence tier, and public provenance projections",
      "Audit verdicts are direction-aware and persist confirmed, disputed, false_positive, no_data, and repaired-style outcomes without deleting rows solely because audit data is weak or absent",
      "PegScore excludes false-positive/disputed events and downweights low-confidence rows while surfacing quality-adjustment counters to callers",
      "DEWS calibration metrics now use stored stress_signal_history as the primary source and report precision, recall, false-positive days, false-negative incidents, lead-time percentiles, churn, and cohorts",
    ],
    commits: [],
    reconstructed: false,
  },
];
