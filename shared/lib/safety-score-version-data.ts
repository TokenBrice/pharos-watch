import type { MethodologyVersionConfig } from "./methodology-version";

export const SAFETY_SCORE_VERSION_CONFIG: MethodologyVersionConfig = {
  currentVersion: "7.14",
  changelogPath: "/methodology/scoring-changelog/",
  changelog: [
    {
      version: "7.14",
      title: "Live reserve dependencies align with scoring",
      date: "2026-04-24",
      effectiveAt: 1777003200,
      summary:
        "Score-grade live reserve slices with tracked `coinId` links now drive Dependency Risk, raw dependency inputs, topological ordering, and the public dependency graph together.",
      impact: [
        "Report-card Dependency Risk now uses the same fresh independent live reserve slices already eligible for collateral-quality scoring when those slices carry tracked stablecoin links",
        "Unmapped live reserve share remains implicit self-backed or non-stablecoin exposure, so live snapshots no longer fall back to stale curated dependency percentages for that remainder",
        "The public dependency graph now publishes the effective dependency edges used by the snapshot, while tracked variant parent wrapper edges remain synthetic and de-duplicated",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.13",
      title: "Reserve-driven blacklist risk moves to Upstream",
      date: "2026-04-22",
      effectiveAt: 1776830400,
      summary:
        "`Possible` blacklist labeling is now reserved for curated direct token or vault freeze controls, while reserve- and custody-driven exposure resolves as `Upstream`.",
      impact: [
        "Shared blacklist resolution now classifies any reserve-side, backing-side, custody-side, or parent-asset freeze path as `inherited` / Upstream instead of keeping a separate sub-threshold `possible` bucket",
        "Curated direct-control overrides remain only on assets whose holder-facing token or vault still exposes a pause, freeze, or blacklist surface, including dormant controls that are currently disabled until governance or admin action",
        "This re-buckets reserve-driven cases such as strategy wrappers, PSM-backed assets, and custody-heavy tokens without changing the existing tracked-variant dependency ceilings or parent-overall cap behavior",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.12",
      title: "sBOLD joins tracked risk-absorption variants",
      date: "2026-04-22",
      effectiveAt: 1776826800,
      summary:
        "The tracked parent-variant framework now includes K3 sBOLD as a `risk-absorption` child of BOLD because Liquity Stability Pool loss-absorption dominates the wrapper's extra risk surface.",
      impact: [
        "`sbold-k3-capital` now declares canonical `variantOf = bold-liquity` and `variantKind = risk-absorption`, so the relationship is visible across Safety Scores, detail pages, homepage variant filters, and the dependency graph",
        "sBOLD now joins the tracked risk-absorption cohort beside `stUSDS` and `stkGHO.v1`, inheriting the existing parent-minus-5 dependency ceiling and parent-overall cap",
        "This phase keeps the current parent-linked `pegReferenceId` path for sBOLD, so severe parent depegs still constrain the child until independent NAV/peg handling ships later",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.11",
      title: "Strategy-vault children join the tracked variant framework",
      date: "2026-04-22",
      effectiveAt: 1776823200,
      summary:
        "The tracked parent-variant framework now covers the four highest-confidence strategy-vault children whose user expectation is still direct exposure to a tracked parent stablecoin.",
      impact: [
        "`sUSDai`, `msY`, `sAID`, and `stcUSD` now declare canonical `variantOf` / `variantKind` metadata as tracked `strategy-vault` children of their already-tracked parent stablecoins",
        "Dependency Risk now applies the same parent-minus-5 wrapper ceiling to tracked `strategy-vault` children that already applied to tracked risk-absorption wrappers, while the existing parent-overall cap still prevents the child from outscoring the parent card",
        "The homepage variant owner on `/` now exposes a `Strategy` filter state alongside the existing tracked, savings, risk-absorption, and bond cohorts",
        "This rollout keeps the current parent-linked `pegReferenceId` path for these four strategy-vault children, so severe parent depegs still constrain the child until independent NAV/peg handling ships in a later phase",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.10",
      title: "Bond-maturity variants join the parent-linked wrapper framework",
      date: "2026-04-22",
      effectiveAt: 1776819600,
      summary:
        "The tracked variant framework now covers bond-maturity wrappers, starting with bUSD0 as a bond leg over USD0.",
      impact: [
        "`bUSD0` now declares canonical `variantOf` / `variantKind` metadata as a `bond-maturity` child of `USD0`, so the relationship is visible across Safety Scores, detail pages, the homepage filters, and the report-card dependency graph",
        "Dependency Risk applies a stricter wrapper ceiling of parent minus 8 points for `bond-maturity` variants, while the existing parent-overall cap still prevents the child from outscoring the parent card",
        "The homepage variant owner on `/` now exposes a `Bond` filter state alongside the existing tracked, savings, and risk-absorption cohorts, and detail pages link back into that owner instead of introducing a dedicated variant route family",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.09",
      title: "Tracked wrapper and staked variants become explicit parent-linked cards",
      date: "2026-04-22",
      effectiveAt: 1776816000,
      summary:
        "Tracked savings and risk-absorption wrappers now carry an explicit parent relationship in Safety Scores, so dependency ceilings, parent caps, and stressed recomputation no longer depend on reserve-shape quirks.",
      impact: [
        "Nine tracked wrapped or staked stablecoins now declare canonical `variantOf` / `variantKind` metadata and contribute a synthetic `wrapper` edge from parent to child in dependency scoring, topological ordering, and the dependency graph",
        "Dependency Risk applies a wrapper ceiling of parent minus 3 points for tracked savings wrappers and parent minus 5 points for tracked risk-absorption wrappers, while legacy non-variant wrapper dependencies keep the existing parent minus 3 behavior",
        "Tracked variants cannot outscore their parent overall card: live cards and stressed recomputation both cap the child at the parent's overall score and expose `overallCapped`, `uncappedOverallScore`, `rawInputs.variantParentId`, and `rawInputs.variantKind` for transparency",
        "Active severe depeg caps now follow inherited `pegReferenceId` links for tracked wrappers, so a parent depeg continues to cap the child even when the wrapper has no direct open-event row of its own",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.08",
      title: "Strategy reserve tier clarification",
      date: "2026-04-21",
      effectiveAt: 1776729600,
      summary:
        "Reserve-risk tiering now distinguishes transparent spot or wrapped market exposure from actively managed strategy books; externally managed market-neutral, basis, perp, LP, private-deal, or custody-dependent strategy reserves are high unless stronger granular evidence shows the slice is only an idle stablecoin or cash-equivalent buffer.",
      impact: [
        "Delta-neutral wording no longer implies a medium reserve-risk tier by itself",
        "Transparent spot or wrapped market exposure can remain medium when the slice is mainly asset exposure and custody/counterparty risk is handled by the custody dimension",
        "Externally managed market-neutral, basis, perp, LP, private-deal, or custody-dependent strategy reserves are high unless stronger granular evidence shows the slice is only an idle stablecoin or cash-equivalent buffer",
        "avUSD's 0xPartners-managed strategy and loss-absorption reserve slices move from medium to high, lowering its reserve-derived collateral quality while leaving its existing unregulated-custody penalty intact",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.07",
      title: "Stale DEX liquidity stays usable for Exit scoring",
      date: "2026-04-18",
      effectiveAt: 1776527157,
      summary:
        "Liquidity / Exit and the redemption-backstop snapshot both now reuse the last-known DEX liquidity score when its freshness runway has elapsed, instead of suppressing it and cascading documented offchain-issuer routes (USDC, USDP, USDT, GUSD, …) to NR on routine sync-dex-liquidity cron lag.",
      impact: [
        "Reverses the v6.1 rule that stripped stale DEX liquidity out of `effectiveExitScore`; the score is now computed from the last-known DEX snapshot regardless of age, and staleness is surfaced only via `liquidityStale` and `inputFreshness.dexLiquidity.stale`",
        "`/api/redemption-backstops.effectiveExitScore` stays populated during stale windows under the same freshness policy as the report-card path, instead of diverging to `null`; the redemption-backstop cron still marks its run `degraded` and emits `metadata.liquidityStale = true` for operational visibility when upstream DEX input is stale. Note that the cron field remains a raw best-path blend and still differs numerically from the report-card `dimensions.liquidity.score`, which applies Safety Score eligibility gates on top",
        "Absent DEX snapshots (loader rejects or empty table) still produce `liquidityScore = null` and trigger the documented offchain-issuer primary-market-floor exclusion as before; the rule only distinguishes between 'present but old' and 'truly missing'",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.06",
      title: "GHO residual decomposition",
      date: "2026-04-16",
      effectiveAt: 1776372651,
      summary:
        "The GHO reserve adapter now decomposes residual issuance across active facilitators and routes unmapped labels through the standard material-unknown-exposure validator, replacing the GHO-specific aggregated-residual warning.",
      impact: [
        "Aave V3 direct-minter facilitators contribute medium-risk residual slices; FlashMinter and unmapped facilitators contribute high-risk slices",
        "Unmapped residual share accumulates into metadata.unknownExposurePct so material unknown exposure can degrade the GHO sync consistently with other reserve adapters",
        "If the facilitator registry is unreadable in a run, the entire residual is treated as unknown so the fail-closed unknown-exposure policy still applies",
        "Direct GhoReserve / GhoDirectFacilitator / RemoteGSM reads remain a follow-up tracked in docs/trackers/reserve-coverage.md pending verified Aave deployment addresses",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.05",
      title: "Primary-market exit bonus",
      date: "2026-04-16",
      effectiveAt: 1776297600,
      summary:
        "Liquidity / Exit now lets documented offchain issuer redemption add a DEX-gated primary-market exit bonus without treating eventual redemption as a standalone liquidity substitute.",
      impact: [
        "Documented-bound offchain issuer routes with eventual-only semantics can contribute only the diversification bonus when a DEX liquidity score is already present",
        "Issuer redemption can no longer replace missing DEX liquidity; no-DEX assets still remain unrated for Liquidity / Exit unless they have separate immediate-bounded redemption evidence",
        "Low-confidence, impaired, stale, route-limited, and severe-depeg-ineligible redemption rows remain excluded from Safety Score liquidity uplift",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.04",
      title: "Redemption freshness runway",
      date: "2026-04-15",
      effectiveAt: 1776283200,
      summary:
        "Liquidity / Exit now keeps current redemption backstops through normal 4-hourly cron lag instead of self-suppressing immediately after one sync interval.",
      impact: [
        "Report-card redemption freshness now follows a 2x 4-hourly sync runway before suppressing redemption inputs",
        "Resolved medium- and high-confidence immediate-bounded redemption backstops can continue to improve Liquidity / Exit between normal 4-hourly syncs",
        "Missing, materially stale, low-confidence, impaired, eventual-only, and severe-depeg-ineligible routes remain excluded from Safety Score liquidity uplift",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.03",
      title: "USTB live liquidity capacity",
      date: "2026-04-15",
      effectiveAt: 1776272400,
      summary:
        "Liquidity / Exit can now use USTB's current Superstate liquidity capacity while keeping NAV/AUM separate from immediate exit capacity.",
      impact: [
        "USTB now uses Superstate's current Circle USD and USDC RedemptionIdle liquidity as bounded redemption capacity",
        "USTB's on-chain NAV oracle remains reserve evidence and is not treated as immediate liquidity",
        "Malformed or unavailable Superstate liquidity telemetry fails closed to no redemption uplift rather than falling back to NAV/AUM",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.02",
      title: "frxUSD live redemption capacity",
      date: "2026-04-15",
      effectiveAt: 1776268800,
      summary:
        "Liquidity / Exit can now use frxUSD's fresh Frax balance-sheet redemption capacity while preserving route-status and capacity-ratio fail-closed guards.",
      impact: [
        "frxUSD no longer relies on a static full-supply eventual redemption model for Safety Score liquidity uplift",
        "Live route-status telemetry from reserve adapters can suppress redemption uplift when a route is paused, degraded, or cohort-limited",
        "Live capacity rows with a nested capacity amount no longer reuse flat reserve-composition ratios as supply-relative capacity ratios",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.01",
      title: "Safety-eligible redemption tiers",
      date: "2026-04-15",
      effectiveAt: 1776250800,
      summary:
        "Liquidity / Exit now distinguishes standalone redemption-route quality from Safety Score-eligible exit capacity.",
      impact: [
        "Eventual-only redemption routes remain visible on redemption surfaces but no longer uplift the Safety Score Liquidity / Exit dimension by themselves",
        "Queue-like redemption routes can still contribute when resolved and current, but their Safety Score contribution is capped before blending with DEX liquidity",
        "Immediate-bounded and live-direct or validated-live routes continue to improve Liquidity / Exit when they are resolved, fresh, non-low-confidence, and not impaired by route-availability evidence",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.0",
      title: "Independent NAV and bundle-oracle reserve feeds",
      date: "2026-04-15",
      effectiveAt: 1776243600,
      summary:
        "Additional proof-style reserve feeds now use independent timestamped sources instead of weak single-asset liveness probes, including Chainlink-style NAV oracles, Frax's v2 balance sheet, and USD1's bundle oracle.",
      impact: [
        "USYC and TBILL now use Chainlink-style NAV oracles with verified oracle timestamps and 4-day business-day freshness windows",
        "FRAX now uses the Frax v2 balance-sheet API with verified as-of timestamps and explicit token risk mapping",
        "USD1 now uses its Chainlink bundle oracle for timestamped reserve size and live supply comparison",
        "AUSD and DGLD remain outside live collateral passthrough for now because their discovered feeds do not currently provide payload-native freshness inside the live gate",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.99",
      title: "Asymmetry USDaf live reserve freshness promotion",
      date: "2026-04-15",
      effectiveAt: 1776240000,
      summary:
        "USDaf's Asymmetry reserve feed now preserves the protocol API timestamp and normalizes branch symbols before risk classification, allowing clean fresh snapshots to qualify for live collateral passthrough.",
      impact: [
        "The Asymmetry adapter now emits verified source freshness from the protocol API timestamp when available",
        "Branch-name normalization prevents casing-only symbols such as wBTC from degrading the feed as unknown exposure",
        "The global live collateral gate remains unchanged: only independent ok-status snapshots with scoring-eligible freshness can drive report-card collateral scoring",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.98",
      title: "Timestamp-backed reserve feeds restored to collateral passthrough",
      date: "2026-04-15",
      effectiveAt: 1776236400,
      summary:
        "Several live reserve adapters now consume source timestamps already exposed by their upstream dashboards or disclosure pages, allowing clean fresh snapshots to qualify for collateral-quality passthrough without weakening the global freshness gate.",
      impact: [
        "Circle, M0, Mento, and USD.AI reserve adapters now emit verified freshness when their upstream source exposes a usable disclosure or update timestamp",
        "Yuzu and Re Protocol reserve feeds now have explicit mappings for newly observed buckets/tokens, preventing clean fresh feeds from being degraded as unknown exposure",
        "OpenEden reserve sync now sends browser-style origin hints to reduce upstream transport failures while preserving the existing verified timestamp validation",
        "Feeds that still lack trustworthy source freshness remain detail-visible only; the report-card live collateral gate still requires independent evidence, ok sync status, and verified or not-applicable freshness",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.97",
      title: "Active-depeg caps use event peak and stale redemption inputs are suppressed",
      date: "2026-04-15",
      effectiveAt: 1776211200,
      summary:
        "Safety Score active-depeg handling now uses the open event's peak severity for final caps, removes the legacy peg-dimension cap, suppresses stale redemption rows, and makes dependency/stress behavior more conservative.",
      impact: [
        "Peg Stability now passes through computePegScore() directly during active depegs instead of applying an extra legacy 65-point cap before the multiplier",
        "RawDimensionInputs.activeDepegBps now uses the open depeg event peak, aligning final Safety Score caps with the severe-redemption impairment source",
        "Report-card Liquidity / Exit suppresses stale redemption-backstop snapshots instead of reusing old redemption uplift indefinitely",
        "Partially unavailable upstream dependency scores are scored at the existing 70-point unavailable fallback for their declared weights rather than being treated as self-backed",
        "The contagion stress test now propagates downstream dependency recomputations transitively instead of stopping at direct dependents",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.96",
      title: "Severe active depegs disable weak redemption uplift",
      date: "2026-04-14",
      effectiveAt: 1776124800,
      summary:
        "Liquidity / Exit no longer accepts static or non-live-direct redemption uplift during severe active depegs unless current live-open redemption evidence exists.",
      impact: [
        "Redemption backstop uplift now requires a resolved non-low-confidence route that is not impaired by route availability or severe active-depeg contradiction",
        "Active depegs at or above 2500 bps disable static, documented-bound, live-proxy, issuer/API, queue, and estimated redemption uplift until live-open evidence returns",
        "Live-direct, dynamic, permissionless, atomic or immediate redemption routes can still contribute to Liquidity / Exit during a severe depeg because they provide current direct exercisability evidence",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.95",
      title: "Direct inherited freeze risk now counts custodied BTC wrappers and issuer-seizable collateral",
      date: "2026-04-07",
      effectiveAt: 1775520000,
      summary:
        "Blacklistability attribution now treats centralized-custody BTC wrappers, tokenized gold, and issuer-seizable tokenized collateral as direct reserve-side freeze exposure when they dominate a stablecoin's backing mix.",
      impact: [
        "Shared isBlacklistable() logic now counts centralized-custody BTC wrappers such as WBTC and cbBTC as direct reserve-side freeze exposure instead of only possible exposure",
        "Issuer-seizable tokenized collateral such as tokenized gold and reviewed tokenized share symbols now also counts as direct inherited freeze risk when present in reserve labels",
        "Coins whose reserve mix crosses the >50% inherited threshold because of these assets now resolve to inherited instead of possible on report-card and table surfaces",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.94",
      title: "NAV wrappers can inherit peg risk from a referenced base stablecoin",
      date: "2026-04-06",
      effectiveAt: 1775476800,
      summary:
        "NAV tokens that are explicit wrappers over a stablecoin can now inherit peg stability from a configured base asset instead of receiving an automatic neutral peg multiplier.",
      impact: [
        "Configured NAV wrappers can now use a referenced base stablecoin's pegScore in report-card scoring when their own NAV share price is not the right peg-tracking surface",
        "Pure NAV fund-share tokens with no configured peg reference still remain pegScore = NR and keep the neutral multiplier treatment",
        "sUSDai now inherits USDAI peg risk, preventing the stronger v6.93 peg multiplier from becoming a free pass for wrapped stablecoin NAV structures",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.93",
      title: "Steeper peg multiplier + active depeg grade cap",
      date: "2026-04-05",
      effectiveAt: 1775347200,
      summary:
        "Peg multiplier exponent raised from 0.2 to 0.4 so peg stability impacts grades more meaningfully. Active depegs above 1000 bps now cap the overall score at D; above 2500 bps caps at F.",
      impact: [
        "PEG_MULTIPLIER_EXPONENT changed from 0.2 to 0.4 — coins with pegScore 80+ see ~1-5% more reduction; coins with pegScore < 30 see 19-34% more reduction",
        "New graduated active depeg cap: >= 2500 bps (25%) caps overall at 39 (F), >= 1000 bps (10%) caps overall at 49 (D)",
        "Active depeg severity (activeDepegBps) added to RawDimensionInputs for reproducibility in stressed grades and frontend",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.92",
      title: "Direct Liquity v1 reserve observation for LUSD",
      date: "2026-04-04",
      effectiveAt: 1775260800,
      summary:
        "LUSD now uses direct on-chain Liquity v1 system-collateral telemetry instead of the generic proof-style liveness probe, so fresh clean snapshots qualify as independent live reserve evidence.",
      impact: [
        "LUSD live reserve sync now reads TroveManager getEntireSystemColl() and getEntireSystemDebt() directly from Ethereum",
        "The reserve detail badge for clean authoritative LUSD snapshots now resolves to live instead of proof because the adapter is classified as independent single-bucket evidence",
        "Weak single-asset probes remain excluded from collateral-quality passthrough; this is a targeted Liquity v1 adapter upgrade rather than a reclassification of the generic family",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.91",
      title: "Reserve-side blacklist exposure heuristics",
      date: "2026-03-30",
      effectiveAt: 1774832400,
      summary:
        "Blacklistability attribution now scans curated and live reserve labels plus reserve-rail text for stablecoin, wrapper, and CEX custody clues, so sub-majority reserve exposure resolves to possible instead of incorrectly falling through to no.",
      impact: [
        "Shared isBlacklistable() logic now returns possible when reserve slices or reserve-rail text imply blacklist or custodial-freeze exposure below the inherited threshold",
        "Inherited status still requires majority direct reserve exposure, but curated and live reserve names now share the same direct blacklist clue detection instead of relying only on coinId or explicit blacklistable flags",
        "Only coins with no explicit blacklist function, no reserve-side blacklist clues, and no CEX custody signal remain in the no bucket unless an explicit false override applies",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.9",
      title: "Explicit inherited blacklistability",
      date: "2026-03-30",
      effectiveAt: 1774828800,
      summary:
        "Blacklistability attribution now separates mutable-contract risk from inherited collateral freeze risk, and no longer treats centralized-dependent governance as enough evidence on its own.",
      impact: [
        "Shared isBlacklistable() logic no longer defaults centralized-dependent governance to possible",
        "Reserve-heavy downstream freeze exposure now resolves to inherited instead of possible-inherited",
        "Inherited detection now requires majority reserve exposure and can use curated reserve-slice blacklistable markers alongside upstream stablecoin coinId links",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.8",
      title: "On-chain reserve freshness alignment",
      date: "2026-03-25",
      effectiveAt: 1774396801,
      summary:
        "Direct latest-state reserve adapters now explicitly mark on-chain freshness as not-applicable, allowing clean independent branch-balance snapshots to participate in collateral-quality passthrough again.",
      impact: [
        "evm-branch-balances snapshots now carry freshnessMode=not-applicable instead of remaining timestamp-less and implicitly ineligible",
        "Clean branch-balance reserve feeds can override curated collateral quality again when their latest reserve sync status is ok",
        "This is an implementation-alignment change to the existing v6.6 freshness policy, not a new scoring rule family",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.7",
      title: "CeFi-dependent blacklistability fallback",
      date: "2026-03-25",
      effectiveAt: 1774396800,
      summary:
        "Blacklistability attribution now defaults centralized-dependent stablecoins to possible unless an explicit override or inherited-reserve classification is more specific.",
      impact: [
        "Shared isBlacklistable() logic now resolves centralized-dependent governance to possible instead of false",
        "Inherited reserve exposure still takes precedence, preserving possible-inherited for reserve-heavy dependency cases",
        "Explicit canBeBlacklisted overrides remain authoritative, including explicit false exceptions",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.6",
      title: "Timestamp-backed live reserve scoring gate",
      date: "2026-03-24",
      effectiveAt: 1774368000,
      summary:
        "Collateral-quality passthrough now excludes timestamp-less or explicitly unverified live reserve feeds unless the feed carries verified freshness or is intrinsically on-chain.",
      impact: [
        "Independent live reserve feeds now need scoring-eligible freshness evidence in addition to fresh authoritative ok-status snapshots",
        "Snapshots with freshnessMode=unverified no longer override curated collateral quality in report-card scoring",
        "Direct on-chain reserve adapters can still qualify when freshness is marked not-applicable",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.5",
      title: "Clean independent live reserve passthrough",
      date: "2026-03-22",
      effectiveAt: 1774195200,
      summary:
        "Collateral-quality passthrough now requires clean independent live reserve evidence, excluding weak probes and warning-bearing snapshots from Safety Score scoring.",
      impact: [
        "Live collateral passthrough now requires a fresh authoritative snapshot whose latest reserve sync status is ok",
        "The live reserve adapter registry now separates reserve shape (sourceModel) from evidence strength (evidenceClass)",
        "single-asset and tether style feeds now remain detail/status-visible only; they no longer override curated collateral scoring",
        "Source-age and material unknown-exposure warnings now automatically keep affected snapshots out of collateral passthrough",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.4",
      title: "Live Liquity redemption fee telemetry",
      date: "2026-03-22",
      effectiveAt: 1774191600,
      summary:
        "The liquidity dimension keeps the same structure, but Liquity-style formula routes can now use current on-chain redemption fees when live reserve telemetry is available.",
      impact: [
        "LUSD and BOLD now reuse live reserve sync metadata for current redemption fee bps instead of always sitting in the generic formula-fee bucket",
        "These routes remain labeled as formula-based and eventual-only; Pharos still does not present them as having an immediate redeemable buffer",
        "If live fee telemetry is unavailable, Safety Score liquidity falls back to the prior reviewed-formula treatment",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.3",
      title: "Documented-bound Liquity redemption confidence",
      date: "2026-03-22",
      effectiveAt: 1774184400,
      summary:
        "Fully on-chain Liquity redemption routes with documented full-system redeemability now qualify as stronger exit-liquidity evidence without being presented as immediate buffer capacity.",
      impact: [
        "LUSD and BOLD now use documented-bound eventual redemption capacity instead of heuristic supply-full modeling",
        "These routes remain eventual-only on detail surfaces, but they can now uplift the Safety Score liquidity dimension",
        "Liquity-style base-rate fee formulas remain reviewed formula inputs rather than fixed-fee assumptions",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.2",
      title: "Independent live reserve contract tightening",
      date: "2026-03-22",
      effectiveAt: 1774180800,
      summary:
        "Collateral-quality passthrough now only uses fresh authoritative independent live reserve feeds, preventing validated-static probes from overriding curated scoring and allowing single-bucket live feeds to count.",
      impact: [
        "Live collateral passthrough now requires a fresh authoritative snapshot matched to reserve_sync_state, not just a fresh reserve_composition row",
        "Only dynamic-mix and single-bucket live feeds can override curated collateral quality; validated-static feeds stay reserve-detail/status only",
        "Single-bucket live feeds now contribute to collateral drift and curated-fallback tracking instead of being excluded by an implicit >=2-slice gate",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.1",
      title: "Redemption confidence gating and capacity semantics",
      date: "2026-03-22",
      effectiveAt: 1774137600,
      summary:
        "Liquidity scoring now distinguishes strong redemption evidence from heuristic routes and stops presenting eventual issuer redemption as immediate buffer capacity.",
      impact: [
        "Low-confidence redemption backstops no longer uplift the Safety Score liquidity dimension",
        "Stale DEX liquidity no longer produces blended effective-exit inputs in report-card scoring",
        "Redemption detail output now separates eventual redeemability from immediate redeemable capacity",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.0",
      title: "Custody model tiers, mature-alt-l1, 2-factor Resilience",
      date: "2026-03-21",
      effectiveAt: 1774051200,
      summary:
        "Four structural changes: 6-tier custody model replaces 3-tier, new mature-alt-l1 chain tier for Solana/BNB, Resilience becomes 2-factor (blacklist descriptive only), 5-band chain penalty with wrapper exemption.",
      impact: [
        "Custody model split: onchain/institutional-top/institutional-regulated/institutional-unregulated/institutional-sanctioned/cex (was onchain/institutional/cex)",
        "USDC, BUIDL, EURC, frxUSD, DAI, USDS classified as institutional-top (80); sanctioned custodians score 5",
        "Mature-alt-l1 tier (score 45) for Solana and BNB Chain; JupUSD, USX, hyUSD, lisUSD, CASH reclassified",
        "Resilience is now (collateral + custody) / 2; blacklist reported but no longer affects score",
        "5-band chain penalty: ≥80→0, ≥60→-10, ≥40→-25, ≥20→-40, <20→-60; wrappers exempted",
        "Deployment multipliers: canonical-bridge 0.85→0.90, native-multichain 0.40→0.75",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.9",
      title: "Classification corrections: centralized-custody DeFi coins",
      date: "2026-03-20",
      effectiveAt: 1773964800,
      summary:
        "Three DeFi-classified coins with >50% centralized custody exposure reclassified to centralized-dependent based on live reserve data.",
      impact: [
        "meUSD, ALUSD, BtcUSD reclassified from decentralized to centralized-dependent",
        "ALUSD correction: 65% USDC+USDT direct exposure (reverts erroneous v4.1 reclassification)",
        "meUSD and BtcUSD: live reserves confirm 100% custodial BTC variants (WBTC, BTCB, cbBTC, SolvBTC)",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.8",
      title: "Live reserve passthrough for collateral quality",
      date: "2026-03-14",
      effectiveAt: 1773446400,
      summary:
        "Collateral quality scoring now consumes live reserve snapshots when available, using hourly data from reserve_composition instead of curated metadata.",
      impact: [
        "Coins with liveReservesConfig use fresh (<48h) live snapshots for collateral quality instead of curated metadata",
        "Delta alert fires when live-derived score diverges from curated by >15 points",
        "Dependency inference remains on curated data (live slices lack coinId links)",
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.7",
      title: "Canonical ETH wrapper reserve alignment",
      date: "2026-03-13",
      effectiveAt: 1773360000,
      summary:
        "Reserve-derived collateral quality now treats direct ETH and canonical wrapped ETH as the same very-low-risk asset class.",
      impact: [
        "Canonical WETH no longer falls into the generic wrapped-asset bucket in the reserve-asset risk map",
        "Curated reserve metadata and live reserve-adapter overrides aligned for coins exposing ETH/WETH slices",
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.6",
      title: "Exit-liquidity integration",
      date: "2026-03-12",
      effectiveAt: 1773273600,
      summary:
        "Safety Score liquidity now evaluates modeled exit quality via redemption backstops, not just raw DEX depth.",
      impact: [
        "Liquidity dimension uses effectiveExitScore, preserving DEX liquidity as floor while redemption quality can improve it",
        "Route-family caps prevent queue-based and offchain issuer systems from appearing unrealistically liquid",
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.5",
      title: "Peg score fairness for young coins",
      date: "2026-03-01",
      effectiveAt: 1772323200,
      summary: "Three peg-scoring fixes prevent young coins with repeated brief depegs from being over-scored.",
      impact: [
        "Tracking window capped to coin age via coinTrackingStart()",
        "Severity magnitude floor ensures each depeg contributes a minimum penalty",
        "Steeper active-depeg penalty: max(5, absBps/50), capped at 50",
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.4",
      title: "No-liquidity penalty",
      date: "2026-02-28",
      effectiveAt: 1772236804,
      summary:
        "When Liquidity is NR (no DEX data), overall score receives a 10% penalty instead of redistributing weight.",
      impact: ["NR liquidity now applies final *= 0.9 after peg multiplier instead of inflating other dimensions"],
      commits: ["14131fa"],
      reconstructed: true,
    },
    {
      version: "5.3",
      title: "Remove chain infra from Resilience",
      date: "2026-02-28",
      effectiveAt: 1772236803,
      summary:
        "Chain infra double-counting fixed: removed from Resilience sub-factors, now exclusively in Decentralization.",
      impact: ["Resilience becomes a 3-factor model (collateral quality, custody model, blacklist capability)"],
      commits: ["8c060b3"],
      reconstructed: true,
    },
    {
      version: "5.2",
      title: "Immutable-code governance tier",
      date: "2026-02-28",
      effectiveAt: 1772236802,
      summary:
        "Added immutable-code as highest GovernanceQuality tier (score 100) for protocols with no admin keys or upgrade path.",
      impact: ["LUSD, BOLD now score 100 in governance quality; exempt from chain infra penalty"],
      commits: ["c6c0b77"],
      reconstructed: true,
    },
    {
      version: "5.1",
      title: "Regulated-entity tier + blacklist softening",
      date: "2026-02-28",
      effectiveAt: 1772236801,
      summary:
        "Blacklist scores softened (blacklistable 0->33) and regulated-entity governance tier added for licensed issuers.",
      impact: [
        "Blacklist scoring: blacklistable 0->33, possible 50->66, not-blacklistable stays 100",
        "Regulated-entity tier (score 40) auto-promoted from single-entity when regulator+license+independent audit",
        "Grade thresholds lowered another 5 points (A+ >= 87)",
      ],
      commits: ["38cbe20", "86b8ce1", "01ed304", "fc6cd6c"],
      reconstructed: true,
    },
    {
      version: "5.0",
      title: "GovernanceQuality + universal dependency scoring",
      date: "2026-02-28",
      effectiveAt: 1772236800,
      summary:
        "Decentralization moved from 3-tier to 6-tier GovernanceQuality. Dependency scoring became universal (not CeFi-only).",
      impact: [
        "GovernanceQuality tiers: dao-governance=85, multisig=55, single-entity=20, wrapper=10",
        "All coins with upstream dependencies now scored, not just centralized-dependent",
        "Chain infra scored as ChainTier x DeploymentModel multiplier in Resilience",
      ],
      commits: ["e915623", "e516bbf", "d4dd044", "0b603d2", "83a540a"],
      reconstructed: true,
    },
    {
      version: "4.1",
      title: "Liquidity weight increase + reclassifications",
      date: "2026-02-27",
      effectiveAt: 1772150403,
      summary:
        "Liquidity weight raised to 30% as the most defining stablecoin attribute. Five coins reclassified to decentralized.",
      impact: [
        "Weights: Liquidity 25->30%, Resilience 25->20%",
        "crvUSD, FRXUSD, USR, GYD, ALUSD reclassified from centralized-dependent to decentralized",
      ],
      commits: ["122733d"],
      reconstructed: true,
    },
    {
      version: "4.0",
      title: "Peg stability becomes a multiplier",
      date: "2026-02-27",
      effectiveAt: 1772150402,
      summary:
        "Biggest structural change: peg stability removed from weighted dimensions and applied as a post-hoc power-curve multiplier.",
      impact: [
        "Peg applied as final *= (pegScore/100)^0.20 instead of 25% dimension weight",
        "Grade thresholds lowered 5 points to compensate for structural deflation",
      ],
      commits: ["6ed2ec9"],
      reconstructed: true,
    },
    {
      version: "3.3",
      title: "Reserve-derived collateral quality",
      date: "2026-02-27",
      effectiveAt: 1772150401,
      summary:
        "For coins with curated reserves arrays, collateral quality is now a weighted average of reserve risk tiers instead of an enum fallback.",
      impact: [
        "Reserve risk tiers: very-low=100, low=75, medium=50, high=25, very-high=5",
        "Decentralization weight raised 10->15%",
      ],
      commits: ["25602d1", "1cd1bb9"],
      reconstructed: true,
    },
    {
      version: "3.2",
      title: "Dependency type ceilings",
      date: "2026-02-27",
      effectiveAt: 1772150400,
      summary:
        "New DependencyType field (wrapper/mechanism/collateral) with ceilings preventing wrappers from scoring above upstream.",
      impact: ["Wrapper ceiling = upstream_score - 3, mechanism ceiling = upstream_score, collateral = no ceiling"],
      commits: ["fa1d992"],
      reconstructed: true,
    },
    {
      version: "3.0",
      title: "Resilience 4-factor model",
      date: "2026-02-26",
      effectiveAt: 1772064001,
      summary:
        "Complete Resilience redesign from 2 factors to 4 equal sub-factors: chain risk, collateral quality, custody model, blacklist capability.",
      impact: [
        "Chain risk, collateral quality, custody model, and blacklist each weighted 25%",
        "New types: ChainRisk, CollateralQuality, CustodyModel with tier-based scoring",
      ],
      commits: ["ff9d589", "46fe511", "c45f007"],
      reconstructed: true,
    },
    {
      version: "2.0",
      title: "Remove Safety dimension",
      date: "2026-02-26",
      effectiveAt: 1772064000,
      summary:
        "Safety dimension removed due to sparse Bluechip rating coverage (~20/142 coins). Bluechip display kept for informational use.",
      impact: ["Safety dimension dropped; weight redistributed to remaining 5 dimensions"],
      commits: ["a272ca8"],
      reconstructed: true,
    },
    {
      version: "1.0",
      title: "Initial implementation",
      date: "2026-02-25",
      effectiveAt: 1771977600,
      summary:
        "First release with six weighted dimensions: Peg Stability, Liquidity, Safety, Resilience, Decentralization, and Dependency Risk.",
      impact: [
        "Six dimensions with grade thresholds from A+ (>=97) to F (>=0)",
        "Minimum 3 rated dimensions required for overall grade",
      ],
      commits: ["66ec5c4", "9c7ccc9", "c11e37c"],
      reconstructed: true,
    },
  ],
};
