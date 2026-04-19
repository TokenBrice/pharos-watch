import { createMethodologyVersion } from "./methodology-version";

const depegDews = createMethodologyVersion({
  currentVersion: "5.95",
  changelogPath: "/methodology/depeg-changelog/",
  changelog: [
    {
      version: "5.95",
      title: "Cross-asset contagion amplifier",
      date: "2026-04-18",
      effectiveAt: 1776470401,
      summary:
        "DEWS now applies a bounded per-peg-type contagion amplifier (max 1.2x) derived from the same cycle's first-pass DANGER/WARNING bands, on top of the existing systemic PSI amplifier.",
      impact: [
        "A tracked stablecoin entering DANGER/WARNING now raises other same-peg-type coins by up to 15% under current constants (1.15x / 1.08x); the amplifier is defensively capped at 20%",
        "First-pass coins that themselves are DANGER/WARNING do not contagion-amplify themselves",
        "Amplifier is clamped, explainable (no learned weights), and surfaced on /api/stress-signals as amplifiers.contagion",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.94",
      title: "Pool-confirmation hardening, backfill atomicity, confirmation-provenance surfacing",
      date: "2026-04-18",
      effectiveAt: 1776470400,
      summary:
        "Pool-only pending promotion now requires 2 pools or >= $5M TVL; backfill delete+insert share a batch; off-chain confirmation is circuit-breaker-guarded; promoted depeg events now persist confirmation_sources and pending_reason.",
      impact: [
        "Single-pool manipulation can no longer unilaterally promote a pending depeg (bar = 2 pools OR one pool with >= $5M TVL)",
        "A worker interruption during backfill no longer leaves a coin with zero depeg rows",
        "A CoinGecko/DefiLlama outage no longer hammers the endpoint for 45 min per pending row",
        "Promoted events carry confirmation_sources (e.g. 'DEX+CEX') and pending_reason (e.g. 'large-cap+low-confidence') for ex-post diagnostics",
        "DEWS liquidity sub-signal fails closed when both 7-day anchors are missing instead of silently contributing 0",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.93",
      title: "Blacklist signal coverage follows direct EVM wave",
      date: "2026-04-15",
      effectiveAt: 1776211201,
      summary:
        "DEWS blacklist-activity input now follows the direct EVM blacklist tracker expansion, adding supported event-count stress signals for FDUSD, BRZ, AUSD, MNEE, EURI, USDQ, USDO, USDX, AID, TGBP, EURC, and BUIDL where those assets are otherwise DEWS-eligible.",
      impact: [
        "The shared supported blacklist symbol set now includes the direct EVM coverage wave",
        "DEWS remains coupled to that shared live tracker set instead of maintaining a separate symbol list",
        "Non-USD amount valuation remains owned by the blacklist tracker; DEWS uses event counts only",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.92",
      title: "Blacklist signal coverage follows first-wave tracker expansion",
      date: "2026-04-15",
      effectiveAt: 1776211200,
      summary:
        "DEWS blacklist-activity input now follows the expanded live blacklist tracker symbol set, adding first-wave issuer-intervention signals for USDG, RLUSD, U, USDtb, and A7A5 where those assets are otherwise DEWS-eligible.",
      impact: [
        "The shared supported blacklist symbol set now includes USDG, RLUSD, U, USDTB, and A7A5",
        "DEWS continues to derive blacklist-signal eligibility from that shared set instead of maintaining a separate list",
        "A7A5's blacklist signal can participate as event-count stress only; non-USD amount valuation remains owned by the blacklist tracker ledger",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.91",
      title: "Conservative DEWS freshness and zero-supply current-row retirement",
      date: "2026-04-11",
      effectiveAt: 1775901000,
      summary:
        "DEWS aggregate freshness now reflects the oldest included current row, and eligible assets with no current circulating supply no longer keep stale current radar rows.",
      impact: [
        "The aggregate `/api/stress-signals` response preserves `updatedAt` as the newest row while adding `oldestComputedAt` and using it for freshness headers",
        "The DEWS cron now retires current `stress_signals` rows for PSI-eligible assets that are explicitly present in the stablecoins cache with zero current supply, without deleting daily history",
        "Last-valid cached rows still remain available for coins that have positive current supply but insufficient signal coverage in an individual cycle",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.9",
      title: "Direction-true confirmation, pending refreshes, and DEWS live-trust alignment",
      date: "2026-04-08",
      effectiveAt: 1775606400,
      summary:
        "Pending depeg incidents now track live first/last/peak state, confirmation requires same-direction corroboration, and DEWS divergence reuses the live depeg DEX trust floor.",
      impact: [
        "Pending rows are now refreshed while they wait for confirmation, preserving first-seen timestamps but updating last-seen and worst-seen state for the active direction",
        "Pending confirmation now treats opposite-side secondary evidence as contradiction instead of support, and native-quote recovery no longer persists contradictory `recovery_price` values",
        "DEWS divergence now ignores fresh-but-thin DEX rows unless they pass the same `$1M` live depeg trust gate, while the repair path refreshes current rows and prunes unrecomputable daily history from the Mar 9, 2026 trust-floor boundary onward",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.8",
      title: "Daily-confirmed native-peg historical replay",
      date: "2026-04-07",
      effectiveAt: 1775578800,
      summary:
        "Supported non-USD fiat historical replay now treats native-fiat CoinGecko history as a day-scale confirmation lane instead of trusting thin hourly native prints on their own.",
      impact: [
        "Historical native-fiat replay now uses daily points plus a two-point confirmation window across 36 hours before opening normal non-USD fiat backfill events",
        "Extreme single-point native crashes of 5,000 bps or more are still preserved even when the native historical confirmation rule would otherwise suppress them",
        "Broad non-USD backfill repairs can now use authenticated CoinGecko market-chart transport consistently through the admin/backfill path, reducing false rebuild drift during large historical cleanups",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.7",
      title: "Launch-date peg-score anchors for older tracked assets",
      date: "2026-04-07",
      effectiveAt: 1775568000,
      summary:
        "PegScore tracking windows now prefer curated launch dates over late-arriving supply-history coverage when the asset metadata provides a trustworthy launch anchor.",
      impact: [
        "PegScore now uses a curated launch date as the age anchor when one is available, falling back to earliest supply-history coverage only when no launch date is curated",
        "Older tracked assets with late `supply_history` coverage no longer appear artificially young in the peg-score window",
        "BRZ now anchors peg-score tracking to its July 19, 2019 launch date instead of a March 2025 supply-history coverage artifact",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.6",
      title: "Generalized native-peg routing and replay for non-USD fiat assets",
      date: "2026-04-07",
      effectiveAt: 1775527200,
      summary:
        "Live and pending depeg routing now generalize the native-peg corroboration lane across the supported non-USD fiat set, and historical replay prefers native fiat market history where CoinGecko exposes it.",
      impact: [
        "Fresh direct native-peg quotes can now veto, sustain, or resolve live depeg state for supported EUR/CHF/GBP/JPY/SGD/AUD/CAD/BRL/IDR/TRY/ZAR/PHP/MXN/RUB/CNH-style fiat pegs instead of remaining effectively BRL-only",
        "Pending confirmation prefers that same direct native quote first whenever CoinGecko exposes the matching fiat pair, reducing false confirmations from USD/FX reference drift",
        "Historical backfill now replays supported non-USD fiat assets against direct native fiat price history and a native `1.0` peg when that series exists, which removes large classes of synthetic backfill events caused by USD/FX mismatch",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.5",
      title: "Direct native-peg corroboration for BRL depeg routing",
      date: "2026-04-07",
      effectiveAt: 1775523600,
      summary:
        "Live and pending depeg routing now checks a fresh direct native-peg quote for supported non-USD fiat assets before trusting a USD-price-versus-FX-reference divergence on its own.",
      impact: [
        "BRZ-style depegs can now be vetoed or resolved by a fresh direct BRL quote when the USD/FX-derived signal is back inside threshold or points the other way",
        "Pending confirmation prefers the fresh direct native-peg quote over a weaker derived USD cross-check when CoinGecko exposes that native pair",
        "Prevents thin BRL reference mismatches from opening, sustaining, or confirming false depeg rows while still preserving genuine native-peg stress",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.4",
      title: "Thin-fiat peg-reference fail-closed and corroborated primary recovery",
      date: "2026-04-07",
      effectiveAt: 1775520000,
      summary:
        "Live depeg state now fails closed when thin non-USD fiat peg references lose their FX fallback, while fresh multi-source primary agreement can retire stale live rows once the coin is back inside threshold.",
      impact: [
        "Thin fiat peg groups with fewer than 3 live contributors now require cached FX fallback before they can open, update, or resolve live depeg state",
        "Fresh non-cached multi-source primary agreement can now close an already-open live event after recovery even if that source mix is still too soft to open new events directly",
        "Prevents BRL-style peer-median false positives from both opening new live rows and lingering as active depegs after the peg reference normalizes",
      ],
      commits: [],
      reconstructed: false,
    },
  {
    version: "5.3",
    title: "DEWS flow baseline continuity on quiet 24-hour windows",
    date: "2026-04-06",
    effectiveAt: 1775433600,
    summary:
      "DEWS no longer drops the mint/burn flow signal just because the latest 24-hour window had zero activity while a mature 30-day baseline still exists.",
    impact: [
      "Coins with >= 7 days of mint/burn history now keep the flow signal available even when the latest 24-hour bucket is quiet",
      "A zero-flow day now contributes zero flow stress instead of silently redistributing the flow weight away from the score",
      "DEWS cron assembly now reflects the documented mint/burn-baseline semantics for mature tracked coins",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.2",
    title: "Corroborated DEX recovery gating for live depeg state",
    date: "2026-04-03",
    effectiveAt: 1775174400,
    summary:
      "Aggregate DEX bridge rows no longer count as sufficient evidence on their own for ambiguous-primary recoveries or recovery-style event suppression.",
    impact: [
      "DEX-assisted live recovery now requires at least two corroborating protocol-level DEX groups inside threshold, not just one trusted aggregate row",
      "Large challenger pools can veto ambiguous-primary DEX recoveries when they still show the old depeg direction",
      "New-event suppression and other aggregate-DEX-driven state mutations now share that stricter corroboration policy, reducing synthetic split events on chronically depegged coins",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.1",
    title: "Ongoing depeg continuity over DEX-only contradiction",
    date: "2026-03-31",
    effectiveAt: 1774915200,
    summary:
      "Already-open depeg events no longer auto-close just because a trusted aggregate DEX row temporarily moves back inside the threshold while the primary path still shows the same-direction depeg.",
    impact: [
      "Same-direction DEX disagreement is now advisory for ongoing events instead of forcing a synthetic recovery boundary",
      "Open depeg rows remain continuous until the standard recovery path confirms a sub-threshold resolution",
      "Prevents repeated event fragmentation on chronically depegged assets when aggregate DEX pricing briefly snaps back toward peg",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.0",
    title: "DEWS blacklist coverage parity and thin-peg FX fallback parity",
    date: "2026-03-28",
    effectiveAt: 1774656000,
    summary:
      "DEWS now applies issuer-freeze signal coverage to the full live blacklistable set and derives thin non-USD peg references with the same cached FX fallback path used elsewhere in the peg-aware pipeline.",
    impact: [
      "Blacklist signal coverage is now derived from the shared supported blacklist symbol set, so PYUSD and USD1 receive the same DEWS blacklist input treatment as USDC, USDT, PAXG, and XAUT",
      "Thin non-USD DEWS divergence inputs now use cached `fxFallbackRates` from the stablecoins payload instead of relying only on sparse peer medians",
      "DEWS input semantics now match the documented blacklist coverage and the live depeg / peg-summary FX-reference path",
    ],
    commits: [],
    reconstructed: false,
  },
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
      "Peg score is now emitted after 7 days of tracking instead of 30, with an 'Early score' label for the 7–30 day window.",
    impact: [
      "Minimum tracking threshold reduced from 30 to 7 days — coins receive a composite peg score after their first week",
      "Scores based on 7–30 days of data are labelled 'Early score' in the hero card (amber text with tooltip)",
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
