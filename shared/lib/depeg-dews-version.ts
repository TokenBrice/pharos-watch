import {
  createMethodologyVersion,
  toMethodologyVersionLabel,
} from "./methodology-version";

const depegDews = createMethodologyVersion({
  currentVersion: "4.6",
  changelogPath: "/methodology/depeg-changelog/",
  changelog: [
  {
    version: "4.6",
    title: "Confidence-aware depeg routing, extreme-move confirmation, and provenance surfacing",
    date: "2026-03-10",
    effectiveAt: 1773144000,
    summary:
      "Depeg detection stopped treating every non-null price as equally trustworthy and now routes ambiguous or catastrophic moves through explicit confirmation paths.",
    impact: [
      "Cached, fallback, low-confidence, and stale primary prices now require confirmation before they can open or close live depeg state",
      "Extreme moves no longer get dropped just for crossing the old <0.5x or >2x peg guardrail; they enter a dedicated confirmation lane instead",
      "peg-summary now exposes price provenance and trust state, and the depeg page consumes backend freshness metadata plus real event-history pagination",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.5",
    title: "Trusted DEX-price gating for depeg suppression, confirmation, and UI checks",
    date: "2026-03-09",
    effectiveAt: 1773056006,
    summary:
      "DEX cross-validation now shares an explicit trust policy so thin pools cannot suppress or confirm depegs, and low-confidence rows no longer surface on the public DEX Price Check UI.",
    impact: [
      "Depeg suppression/confirmation now requires fresh DEX rows with >= $1M aggregate source TVL",
      "UI-facing dexPriceCheck exposure now requires fresh data with >= $250K aggregate source TVL",
      "Thin DEX rows can no longer veto new depeg events or promote pending confirmations on their own",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.4",
    title: "No-history coins now return null peg score",
    date: "2026-03-02",
    effectiveAt: 1772449220,
    summary:
      "Peg score stopped treating coins with neither first-seen supply history nor depeg events as implicitly healthy.",
    impact: [
      "coinTrackingStart now returns null when both firstSeen and events are absent",
      "computePegScoreWithWindow now yields null pegScore for insufficient-history coins",
      "Prevents false perfect-score outcomes on sparse or incomplete datasets",
    ],
    commits: ["71cc096"],
    reconstructed: true,
  },
  {
    version: "4.3",
    title: "Young-coin fairness and stronger active penalties",
    date: "2026-03-01",
    effectiveAt: 1772396348,
    summary:
      "Peg score became less permissive for young coins with recurring brief depegs and for currently depegged assets.",
    impact: [
      "Tracking start formalized as max(firstSeen, fourYearsAgo) with earliest-event fallback",
      "Per-event severity now applies max(duration penalty, magnitude floor)",
      "Active-depeg penalty steepened to max(5, absBps/50), capped at 50",
    ],
    commits: ["fd83a46"],
    reconstructed: true,
  },
  {
    version: "4.2",
    title: "DEWS wave-2: yield signal + PSI amplifier",
    date: "2026-03-01",
    effectiveAt: 1772379888,
    summary:
      "DEWS expanded beyond market microstructure signals by incorporating yield-warning telemetry and systemic PSI context.",
    impact: [
      "Added 8th DEWS sub-signal: yield anomaly (weight 0.05)",
      "Introduced systemic amplifier: DEWS boosted up to +30% when PSI < 75",
      "Cron now reads yield_data.warning_signals and latest PSI sample before scoring",
    ],
    commits: ["dcdefde"],
    reconstructed: true,
  },
  {
    version: "4.1",
    title: "DEWS pool stress calibration fix",
    date: "2026-03-01",
    effectiveAt: 1772379476,
    summary:
      "Corrected pool-stress scaling error that was inflating DEWS pool signal values.",
    impact: [
      "avg_pool_stress is now consumed as native 0-100 (removed erroneous x100)",
      "Pool component returned to intended weighting and magnitude",
      "Reduced false high-band classifications caused by scale inflation",
    ],
    commits: ["2d8f867"],
    reconstructed: true,
  },
  {
    version: "4.0",
    title: "DEWS launch (7-signal model + 15-minute cron)",
    date: "2026-03-01",
    effectiveAt: 1772377285,
    summary:
      "Launched the Depeg Early Warning System with per-coin stress scoring and persisted 15-minute snapshots.",
    impact: [
      "Introduced DEWS base model with 7 sub-signals and weighted-redistribution scoring",
      "Threat bands established: CALM, WATCH, ALERT, WARNING, DANGER",
      "compute-dews cron writes rolling stress_signals and daily stress_signal_history snapshots",
    ],
    commits: ["a87876c", "9bfe791"],
    reconstructed: true,
  },
  {
    version: "3.2",
    title: "Tracking-window direction fix",
    date: "2026-02-27",
    effectiveAt: 1772187654,
    summary:
      "Corrected tracking-start math to avoid diluting young-coin depeg severity across pre-launch periods.",
    impact: [
      "Lookback boundary corrected from min(firstSeen, fourYearsAgo) to max(...)",
      "Peg-time and severity now computed against realistic coin lifetime bounds",
      "Young-coin scores became less artificially inflated",
    ],
    commits: ["74aa1cd"],
    reconstructed: true,
  },
  {
    version: "3.1",
    title: "Confirmation and detector hardening",
    date: "2026-02-26",
    effectiveAt: 1772117934,
    summary:
      "Hardened confirmation and detection against invalid references, non-finite values, and partial-write edge cases.",
    impact: [
      "Pending rows with invalid peg_reference are dropped before confirmation math",
      "Detection now rejects non-finite peg references before bps computation",
      "Pending confirmation mutations are batched atomically for consistent state transitions",
    ],
    commits: ["c2832ae", "61e8f9b", "c868ba2", "76aa8c6"],
    reconstructed: true,
  },
  {
    version: "3.0",
    title: "Two-stage confirmation for large-cap depegs",
    date: "2026-02-25",
    effectiveAt: 1772018098,
    summary:
      "Large-cap depeg detection moved from single-source trigger to a pending-confirmation pipeline with secondary-source validation.",
    impact: [
      ">= $1B coins now route through depeg_pending before promotion to depeg_events",
      "Secondary agreement uses CoinGecko and/or DEX with a 50% threshold bar",
      "sync-stablecoins now runs detectDepegEvents and confirmPendingDepegs sequentially each cycle",
    ],
    commits: ["ece06dd", "c1adfa7", "5fac720", "9854efe", "8c5a9b9"],
    reconstructed: true,
  },
  {
    version: "2.1",
    title: "Four-year peg-score lookback window",
    date: "2026-02-20",
    effectiveAt: 1771617846,
    summary:
      "Peg scoring moved to an explicit rolling 4-year horizon instead of unbounded historical span.",
    impact: [
      "computePegScoreWithWindow introduced a 4-year tracking cap",
      "Detail-page peg scores became explicitly lookback-bounded",
      "Boundary logic was later corrected in v3.2 for firstSeen direction",
    ],
    commits: ["29c1bdc"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "Peg-score severity rebalance + spread penalty",
    date: "2026-02-20",
    effectiveAt: 1771586345,
    summary:
      "Peg score shifted to stronger magnitude sensitivity and penalized erratic event-size variance.",
    impact: [
      "Severity penalty changed from sqrt-based to linear (peakBps/100 scaling)",
      "Added spreadPenalty from event-magnitude standard deviation (cap 15)",
      "Composite became: 0.5*pegPct + 0.5*severity - activePenalty - spreadPenalty",
    ],
    commits: ["d2954c3"],
    reconstructed: true,
  },
  {
    version: "1.2",
    title: "Non-USD thresholding + ongoing false-positive control",
    date: "2026-02-20",
    effectiveAt: 1771581783,
    summary:
      "Depeg detection adopted peg-type-aware thresholds and began actively retiring stale false-positive open events.",
    impact: [
      "Non-USD depeg threshold raised to 150 bps (USD remained 100 bps)",
      "Cleanup migration removed legacy non-USD events below 150 bps",
      "Ongoing events auto-close after sustained DEX disagreement (30m+, >=$1M TVL)",
    ],
    commits: ["9c0d1a6", "7bc5361", "8b01716"],
    reconstructed: true,
  },
  {
    version: "1.1",
    title: "Early lifecycle hardening + active penalty floor",
    date: "2026-02-18",
    effectiveAt: 1771407222,
    summary:
      "Early stability pass reduced under-penalization and fixed event-time accounting/state-lifecycle edge cases.",
    impact: [
      "Added active-depeg penalty to peg score, then introduced a minimum floor",
      "Merged overlapping depeg intervals to prevent pegPct double-counting",
      "Detection now closes orphan open events and tracks open state by event ID",
    ],
    commits: ["cb67892", "c6c1391", "4c818f5", "8b0fe61"],
    reconstructed: true,
  },
  {
    version: "1.0",
    title: "Initial Depeg Tracker scoring + live event detection",
    date: "2026-02-18",
    effectiveAt: 1771397626,
    summary:
      "First operational release of depeg scoring and event detection primitives.",
    impact: [
      "Launched computePegScore baseline (peg time + severity blend)",
      "Introduced detectDepegEvents cron pipeline with live open/close/update logic",
      "Added duplicate-open-event merge and new-event DEX disagreement suppression",
    ],
    commits: ["f1ea0d8", "2556ae4"],
    reconstructed: true,
  },
  ],
});

/** Canonical Depeg Tracker + DEWS methodology version (no "v" prefix). */
export const DEPEG_DEWS_METHODOLOGY_VERSION = depegDews.currentVersion;

/** Display-ready Depeg Tracker + DEWS methodology version (with "v" prefix). */
export const DEPEG_DEWS_METHODOLOGY_VERSION_LABEL = depegDews.versionLabel;

/** Public changelog route for Depeg Tracker + DEWS methodology history. */
export const DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH = depegDews.changelogPath;

/** Reconstructed changelog data. */
export const DEPEG_DEWS_METHODOLOGY_CHANGELOG = depegDews.changelog;

/** Resolve Depeg Tracker + DEWS methodology version active at a given Unix timestamp (seconds). */
export const getDepegDewsMethodologyVersionAt = depegDews.getVersionAt;

export const toDepegDewsMethodologyVersionLabel = toMethodologyVersionLabel;
