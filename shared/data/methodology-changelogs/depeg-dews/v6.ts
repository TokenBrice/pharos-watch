import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_DEWS_V6: readonly MethodologyChangelogEntry[] = [
  {
    version: "6.096",
    title: "Native-peg events preserve one quote domain",
    date: "2026-07-11",
    effectiveAt: 1783728000,
    summary:
      "Live events opened from direct native-fiat quotes now keep native prices throughout peak and recovery persistence instead of mixing later USD-domain observations into the row.",
    impact: [
      "Native-quote events update peaks only from subsequent native quotes against the stored `1.0` peg reference",
      "A recovered native quote closes the event with `recovered-native` and the same-domain native recovery price",
      "When only a USD primary or DEX recovery is available, the event can still close but persists `recovery_price = NULL` rather than mixing quote units",
      "The known BRLA event 90509 mixed-unit recovery value is cleared through a guarded data migration",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.095",
    title: "Native-fiat quotes can initiate live non-USD depegs",
    date: "2026-07-08",
    effectiveAt: 1783468800,
    summary:
      "Supported non-USD fiat assets can now open live depeg state from a fresh direct native-fiat quote when the USD price against a peer-median peg reference remains inside threshold.",
    impact: [
      "Direct native CoinGecko quotes remain able to veto, sustain, and resolve non-USD depeg rows; they can now also initiate the row when they are the clearest fresh signal",
      "Small and mid-cap native-quote events open immediately with the native quote stored against a `1.0` peg reference, matching the historical native-fiat replay model",
      "Large-cap or extreme native-quote triggers still route through `depeg_pending` before public event creation",
      "This prevents BRL peer medians from masking true BRLA/BRL discounts while preserving the existing 150 bps non-USD threshold",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.094",
    title: "Mint/burn flow freshness fails closed",
    date: "2026-06-23",
    effectiveAt: 1782172800,
    summary:
      "DEWS now separates mint/burn baseline coverage from true source freshness, so the Flow sub-signal requires a fresh 24-hour mint_burn_hourly row plus at least 7 baseline days.",
    impact: [
      "A mature 30-day baseline no longer produces available zero flow stress when the mint/burn pipeline has no fresh 24-hour row",
      "Fresh zero-volume 24-hour rows still contribute zero flow stress when the source is current",
      "Stale mint/burn hourly input is recorded as a `mint-burn-hourly-freshness` source failure and surfaced through `sourceAges.mintBurn` and `staleFlags.mintBurn`",
      "`flowBaselineDays` remains the baseline coverage diagnostic, while `flowDataAgeDays` now reports true mint/burn source freshness age in days",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.093",
    title: "Independent primary-family severe moves can open immediately",
    date: "2026-06-21",
    effectiveAt: 1782000000,
    summary:
      "Non-large-cap extreme depeg moves no longer have to wait in pending confirmation when the current primary price is fresh and already spans independent source families.",
    impact: [
      "Single-source or same-family extreme prints still route through `depeg_pending` before public event creation",
      "Fresh severe moves with at least two independent primary depeg source families, such as CoinGecko plus DefiLlama, can open a live event immediately below the $1B large-cap floor",
      "Large-cap assets still require the existing pending-confirmation path even when the severe move is multi-source",
      "The change prevents confirmed small- and mid-cap crashes from being hidden until DEX confirmation catches up",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.092",
    title: "Pool-challenged recoveries keep active depegs open",
    date: "2026-06-19",
    effectiveAt: 1781827200,
    summary:
      "Live depeg detection now rejects an in-band primary recovery print when qualifying individual DEX pool challengers still show the existing depeg direction.",
    impact: [
      "A single high-TVL pool (>= $5M) or at least two independent protocol/source-family pool groups can veto primary-price recovery closure",
      "This covers cases where aggregate off-chain prices briefly print near peg while a large venue remains materially depegged",
      "Small single-pool disagreements remain advisory and do not block authoritative primary recovery by themselves",
      "The change hardens long-running incidents such as the APXUSD June 2026 underpeg against transient near-$1 blips",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.091",
    title: "DEX-contradicted recoveries keep active depegs open",
    date: "2026-06-16",
    effectiveAt: 1781568000,
    summary:
      "Live depeg detection no longer closes an existing event from an authoritative near-peg primary print when fresh trusted DEX evidence with multiple independent protocol groups still shows the event's original depeg direction.",
    impact: [
      "Authoritative primary recovery still closes an event when there is no qualifying DEX contradiction",
      "When trusted aggregate DEX price and at least two protocol groups still cross the threshold in the existing event direction, the event remains open and the contradictory recovery is logged",
      "This prevents brief off-chain or consensus near-peg prints from splitting unresolved long-running incidents such as the APXUSD June 2026 underpeg",
      "DEX-confirmed recoveries remain supported: ambiguous primary recoveries can still close when aggregate DEX and enough protocol groups are back inside threshold with no challenger contradiction",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.09",
    title: "Wider venue-risk coverage feeds the structured-venue branch",
    date: "2026-06-15",
    effectiveAt: 1781481600,
    summary:
      "Yield Intelligence v8.292 expands the reviewed venue-risk registry from 12 to 61 venues, so DEWS's existing structured-venue Yield Anomaly branch now fires for the previously-unscored long tail without any DEWS threshold change.",
    impact: [
      "The `structured-high-risk-venue` (+25) and `structured-medium-risk-venue` (+10) branches are unchanged, but `sourceRisk.venueRiskTier` is now derived from a 5-category Yearn-style score across 61 venues instead of 12 hand-set tiers",
      "Newly-scored high-risk venues (e.g. Clearpool, Goldfinch, 3Jane, Aries Markets, Curvance, Avantis) now contribute `structured-high-risk-venue` to the Yield Anomaly sub-signal for coins routing yield through them",
      "Newly-scored medium-risk venues (e.g. Fluid, Dolomite, Fraxlend v2, Felix, Centrifuge, Jupiter Lend, Sovryn) now contribute `structured-medium-risk-venue`",
      "Reviewer-set cross-venue dependency concentration raises the source-risk penalty, which can cross the existing +20 `structured-source-risk-penalty` threshold for affected rows",
      "No DEWS code, weight, threshold, or cap changed; unknown/low venues remain a no-op",
    ],
    commits: [],
    reconstructed: false,
  },
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
