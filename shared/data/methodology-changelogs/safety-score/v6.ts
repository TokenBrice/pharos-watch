import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V6: readonly MethodologyChangelogEntry[] = [
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
        "Coins with these reviewed collateral assets gained inherited-freeze treatment in this phase; v7.13 later superseded the reserve-weight gate with the current any-reserve Upstream policy",
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
        "PEG_MULTIPLIER_EXPONENT changed from 0.2 to 0.4: coins with pegScore 80+ see ~1-5% more reduction; coins with pegScore < 30 see 19-34% more reduction",
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
        "Blacklistability attribution began scanning curated and live reserve labels plus reserve-rail text for stablecoin, wrapper, and CEX custody clues; v7.13 later promoted any matched reserve path to Upstream.",
      impact: [
        "Shared isBlacklistable() logic started surfacing reserve-side blacklist and custodial-freeze clues instead of falling through to no",
        "Curated and live reserve names started sharing the same direct blacklist clue detection instead of relying only on coinId or explicit blacklistable flags; v7.13 later removed the reserve-weight gate",
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
        "Inherited detection became an explicit upstream-freeze category using curated reserve-slice blacklistable markers and upstream stablecoin coinId links; v7.13 later removed the reserve-weight gate",
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
];
