import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_DEWS_V4: readonly MethodologyChangelogEntry[] = [
  {
    version: "4.9",
    title: "Bootstrap sentinel and core-liquidity freshness gating",
    date: "2026-03-23",
    effectiveAt: 1774260000,
    summary:
      "DEWS bootstrap is now a one-time state transition, and stale or missing core liquidity inputs no longer masquerade as acceptable startup conditions.",
    impact: [
      "Bootstrap grace now ends after the first successful DEWS publication via a dedicated `dews:bootstrap-complete` sentinel instead of piggybacking on stablecoins-cache freshness",
      "Only explicitly optional missing tables remain bootstrap-allowed before first success; core dependencies no longer inherit that grace",
      "Fresh `dex_liquidity` is now required for publication, with rows older than 2 hours treated as a hard degraded source failure",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.8",
    title: "Contradicted live depegs now retire into pending confirmation",
    date: "2026-03-22",
    effectiveAt: 1774173665,
    summary:
      "When a low-confidence primary price now contradicts an open live depeg across the peg, the stale live row is retired immediately and the replacement move waits in pending confirmation instead of leaving the wrong direction active.",
    impact: [
      "Opposite-direction live depeg rows no longer remain active just because the correcting primary price is still confirm_required",
      "Direction flips from cached, fallback, low-confidence, or stale primary inputs now close the stale live row and insert a replacement pending candidate",
      "Public active-depeg state stops claiming the wrong side of the peg while confirmation catches up on the corrected move",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.7",
    title: "Early peg score: minimum data threshold lowered from 30 to 7 days",
    date: "2026-03-21",
    effectiveAt: 1774051200,
    summary:
      "Peg score is now emitted after 7 days of tracking instead of 30, with an 'Early score' label for the 7-30 day window.",
    impact: [
      "Minimum tracking threshold reduced from 30 to 7 days, so coins receive a composite peg score after their first week",
      "Scores based on 7-30 days of data are labelled 'Early score' in the hero card (amber text with tooltip)",
      "Report card peg-stability dimension is now rated from day 7; NR only appears for coins with < 7 days of history",
    ],
    commits: [],
    reconstructed: false,
  },
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
];
