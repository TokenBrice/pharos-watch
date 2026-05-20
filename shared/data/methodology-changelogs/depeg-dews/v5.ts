import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_DEWS_V5: readonly MethodologyChangelogEntry[] = [
  {
    version: "5.99",
    title: "Structured Yield Source-Risk DEWS Input",
    date: "2026-05-13",
    effectiveAt: 1778700960,
    summary:
      "DEWS now consumes populated Yield Intelligence source-risk and rank-attribution fields inside the existing Yield Anomaly sub-signal, while neutral or missing structured rows remain no-ops.",
    impact: [
      "The `yield` sub-signal can now score populated `sourceRisk.rewardShare`, `sourceRisk.sourceDepthRatio`, `sourceRisk.sourceAgeSeconds`, `sourceRisk.sourceSwitchCount30d`, `sourceRisk.sourceRiskPenalty`, high reviewed `venueRiskTier`, and rank-attribution source-risk/source-switch drivers",
      "Structured yield evidence is additive with existing `yield_data.warning_signals` and still caps the Yield Anomaly sub-signal at 100",
      "Neutral structured rows do not become available zero-stress signals, so missing or neutral evidence does not dilute the DEWS weighted average",
      "The DEWS source-state loader reads structured evidence from the published `yield-rankings` cache and preserves legacy warning-only behavior when that cache is missing or malformed",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.98",
    title: "Registry-backed depeg source families",
    date: "2026-05-12",
    effectiveAt: 1778612253,
    summary:
      "Depeg trust and pending-confirmation policy now resolve source families from pricing-source registry metadata, expanding composite labels before family and authority checks.",
    impact: [
      "Composite labels such as `coingecko+geckoterminal` are expanded before source-family checks, so they no longer behave like unknown standalone sources",
      "CoinGecko variants, DefiLlama list/detail/contract variants, and CoinMarketCap-style list aggregators remain correlated families for confirmation and severe-downside corroboration",
      "Fallback/search lanes remain non-authoritative, while hard market, oracle, protocol, and promoted DEX protocol lanes keep explicit registry-backed families",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.97",
    title: "Source-family confirmation and zero-event backfill parity",
    date: "2026-05-11",
    effectiveAt: 1778457600,
    summary:
      "Pending depeg confirmation now requires source-family-aware corroboration, stricter DEX/pool independence, refreshed peg references, and canonical confirmer provenance; trusted zero-event backfills now remove stale backfill rows.",
    impact: [
      "CoinGecko/DefiLlama off-chain confirmation is selected from the primary agreeSources family set, so same-family circular evidence cannot promote large-cap pending rows on its own",
      "Aggregate DEX confirmation requires at least two fresh protocol groups, and pool challengers count distinct protocol/source-family groups while preserving the documented >= $5M single-pool exception",
      "Promoted pending rows use refreshed peg references, canonical confirmation_sources keys, and the worst trustworthy confirmer price when setting peak severity",
      "Backfill dry-runs and mutating runs now agree when a trusted replay finds zero events: stale source='backfill' rows are previewed and then deleted",
      "Historical replay applies the live supply floor from historical supply or current stablecoins-cache supply; when both are absent, existing backfill rows are preserved",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.96",
    title: "ARS native-peg and KGS FX corroboration",
    date: "2026-05-05",
    effectiveAt: 1777983570,
    summary:
      "Direct native-peg corroboration now includes ARS where CoinGecko exposes a supported quote currency, while KGS stays on the secondary daily FX path and deterministic bounds because CoinGecko does not expose a native KGS quote.",
    impact: [
      "WARS (ARS) live and pending depeg checks can use fresh native CoinGecko quotes before trusting USD/FX-derived divergence on its own",
      "KGST (KGS) depeg checks use the secondary daily FX mirror and hardcoded validation bounds rather than an unsupported CoinGecko KGS quote",
      "Historical replay behavior is unchanged except that assets with native ARS market history can prefer that direct native series when available",
    ],
    commits: [],
    reconstructed: false,
  },
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
      "DEWS aggregate responses now expose oldest-row lag separately, and eligible assets with no current circulating supply no longer keep stale current radar rows.",
    impact: [
      "The aggregate `/api/stress-signals` response preserves `updatedAt` as the newest row used for freshness headers while adding `oldestComputedAt` as a body-only lag diagnostic",
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
];
