import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V7: readonly MethodologyChangelogEntry[] = [
    {
      version: "7.27",
      title: "FreezeWatch removes Dilutable admin-mint tier",
      date: "2026-05-24",
      effectiveAt: 1779580800,
      summary:
        "FreezeWatch now uses a four-status freeze model: Yes, Upstream, Possible, and No. Admin mint authority is retained in the descriptive Mint Authority review instead of being mixed into freeze exposure.",
      impact: [
        "The `Dilutable` FreezeWatch/report-card status is retired; legacy snapshot reads map it into the current model for compatibility",
        "Former Dilutable assets are re-reviewed under freeze-only semantics: most now resolve as Upstream through collateral, custody, parent, or reserve exposure; USDN (SMARDEX) resolves as Possible; KRWO, LUAUSD, and vCRED resolve as No",
        "Mint Authority remains descriptive and unscored, but it is now the explicit home for privileged supply-control risk",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.26",
      title: "NAV wrapper peg scoring uses configured peg references first",
      date: "2026-05-21",
      effectiveAt: 1779321600,
      summary:
        "NAV and savings wrappers with a configured peg reference now ignore their own appreciating share price for Safety Score peg and active-depeg caps, using the referenced base stablecoin's peg state instead.",
      impact: [
        "Yield-accruing wrapper prices above $1 no longer trigger active-depeg caps solely because the share price has appreciated",
        "Tracked wrappers such as fxSAVE inherit peg risk from the configured base asset, while pure NAV tokens without a valid peg reference remain neutral/NR for peg tracking",
        "Structural wrapper, dependency, collateral, and liquidity risks remain scored independently from the peg-reference correction",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.25",
      title: "Wrapper decentralization inherits from tracked parent assets",
      date: "2026-05-15",
      effectiveAt: 1778803200,
      summary:
        "Tracked wrappers with a resolvable parent asset now derive Decentralization from the wrapped asset's Decentralization score, with the same wrapper-kind haircut used for dependency ceilings.",
      impact: [
        "Parent-linked wrappers such as yBOLD, sBOLD, and sfrxUSD no longer receive the old flat 10-point Decentralization score when their wrapped asset is already tracked",
        "Savings wrappers inherit parent Decentralization minus 3 points; strategy-vault and risk-absorption variants inherit parent minus 5; bond-maturity variants inherit parent minus 8",
        "Wrappers without a resolvable single tracked parent still fall back to the conservative 10-point wrapper score",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.24",
      title: "Capacity-aware redemption effective-exit blending",
      date: "2026-05-12",
      effectiveAt: 1778605200,
      summary:
        "Liquidity / Exit now consumes Redemption Backstop v4 current-capacity semantics, scaling redemption uplift by executable capacity, model confidence, and independence from DEX liquidity.",
      impact: [
        "Eventual-only issuer or protocol routes remain visible as redemption coverage but no longer create redemption-only Safety liquidity uplift when current executable capacity is not modeled",
        "Redemption contribution to `effectiveExitScore` is discounted when current capacity is small relative to the modeled exit size or when route confidence is medium/low",
        "The diversification bonus is reserved for plausibly independent issuer rails; wrappers, same-protocol routes, same stablecoin-pool/backing paths, and unknown correlations receive no extra independence bonus",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.23",
      title: "sGHO and Reservoir reserve coverage refinements",
      date: "2026-05-12",
      effectiveAt: 1778605200,
      summary:
        "Additional reserve-sync refinements promote clean independent snapshots for sGHO, Reservoir savings variants, USD.AI, and weekly NAV feeds without widening the score-grade evidence policy.",
      impact: [
        "sGHO now has a dedicated live reserve adapter that reads the legacy savings contract's `previewRedeem(totalSupply)` path instead of forcing the non-ERC-4626 contract through the generic wrapper adapter",
        "Reservoir reserve classification now maps AUSD and Steakhouse Prime USDC strategy rows from the live balance-sheet API, eliminating the prior unknown-exposure degradation for srUSD/wsrUSD when the source payload is otherwise clean",
        "USD.AI reserve freshness now stamps the latest scoped proof-row timestamp while retaining oldest/latest spread metadata, and mRe7YIELD allows a weekly Chainlink NAV update cadence",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.22",
      title: "Additional independent NAV and wrapper reserve feeds",
      date: "2026-05-12",
      effectiveAt: 1778599200,
      summary:
        "More RWA NAV tokens and tracked savings wrappers now use direct independent reserve feeds instead of curated validation or weak liveness probes.",
      impact: [
        "WTGXX, VBILL, ACRED, USTBL, EUTBL, and JTRSY now use timestamped Chainlink NAV feeds for score-grade reserve freshness",
        "USDCV now uses the SG Forge CoinVertible reserve parser, aligning it with EURCV's independent attestation path",
        "sUSDD and sUSN now use ERC-4626 totalAssets()/asset() wrapper reads so their live reserve slices inherit the tracked USDD and USN parent links",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.21",
      title: "crvUSD direct on-chain LLAMMA reserve reads",
      date: "2026-05-12",
      effectiveAt: 1778544000,
      summary:
        "crvUSD reserve scoring can now use direct Curve ControllerFactory and LLAMMA band reads with latest-state on-chain freshness instead of the timestampless Curve markets API.",
      impact: [
        "`crvusd-curve` reads LLAMMA `bands_y` collateral balances directly via Multicall3 and keeps Yield Basis exposure on the existing on-chain factory path",
        "`bands_x` crvUSD soft-liquidation inventory is retained in snapshot metadata instead of being counted as external collateral",
        "The adapter emits `freshnessMode: \"not-applicable\"`, allowing clean crvUSD snapshots to qualify as score-grade live reserve inputs",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.20",
      title: "Expanded Dilutable admin-mint classification with source provenance",
      date: "2026-05-11",
      effectiveAt: 1778500800,
      summary:
        "A full tracked-universe follow-up to the Dilutable rollout expands the tier to strong uncapped admin-mint candidates and records a contract-source link for every Dilutable override.",
      impact: [
        "DAI, DOLA, FPI, PHT, USDD, USDe, USDN (SMARDEX), crvUSD, REUSD, USDU, and XAI now resolve as `Dilutable` after verified token-source review found explicit uncapped admin mint authority",
        "Every `canBeBlacklisted: \"dilutable\"` metadata override now carries `canBeBlacklistedSource`, and the asset schema rejects Dilutable entries without a source link",
        "The homepage table and stablecoin detail hero expose the Dilutable source link directly on the status label",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.19",
      title: "Dilutable freezability tier and upgradeable-proxy / admin-mint audit",
      date: "2026-05-11",
      effectiveAt: 1778457600,
      summary:
        "A re-audit of 22 stablecoins marked `Freezable: No` introduces a new `Dilutable` tier for tokens whose admin can mint without bound, and reclassifies five coins to `Yes` after finding upgradeable proxies or active admin freeze surfaces.",
      impact: [
        "New `Dilutable` tier sits between `No` and direct `Yes`: the token has no transfer freeze or blacklist, but the issuer can mint unbounded supply and effectively seize value through dilution",
        "vCRED, LUAUSD, and srUSD now resolve as `Dilutable` because their token contracts expose `Ownable` mint or `AccessControl` minter-grant authority without supply caps",
        "HBD, mRe7YIELD, FEUSD (Felix), USDQ (Quill), and USDK (Orki) now resolve as direct `Freezable: Yes` after the audit confirmed transparent upgradeable proxies, `Blacklistable`/`Pausable` mixins, or chain-native witness-seizure precedent (HF23)",
        "BabelFish XUSD's explicit `canBeBlacklisted: false` override is removed so reserve-based inheritance from its bridged USDT/USDC basket now flows through to `Freezable: Upstream`",
        "DJED, IUSD (Indigo), HYUSD, FXD, FUSD (Zano), NXUSD, SILK, DLLR, USG, LUSD, BOLD, CJPY, and JUSD (Juicedollar) keep their defensible `Freezable: No` after token-contract or chain-level review",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.18",
      title: "Redemption freshness and daily-limit eligibility gates",
      date: "2026-05-10",
      effectiveAt: 1778371200,
      summary:
        "Liquidity / Exit now consumes the stricter redemption-backstop live telemetry policy, so unverified nested redemption freshness is excluded unless route-specific lower-bound approval exists and live daily limits cap usable scoring capacity.",
      impact: [
        "Severe active-depeg survivability now requires direct live capacity kind evidence in addition to live-direct confidence, dynamic source mode, permissionless access, and atomic/immediate settlement",
        "Live reserve adapters can surface redemption constraints such as queue depth, settlement delay, daily limits, and minimum redemption size without those fields being mistaken for unconditional Safety eligibility",
        "Daily redemption limits reduce the capacity score used by redemption-backed Liquidity / Exit while leaving raw immediate capacity visible in the redemption API",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.17",
      title: "USD3 centralized-collateral dependency correction",
      date: "2026-05-07",
      effectiveAt: 1778112000,
      summary:
        "USD3 / Web 3 Dollar is reclassified from DeFi to CeFi-dependent because its Reserve Protocol DTF basket is concentrated in centralized stablecoin-derived collateral.",
      impact: [
        "`usd3-reserve-protocol` now uses governance `centralized-dependent` instead of `decentralized`",
        "The correction reflects Savings USDS, Aave USDC, wrapped Compound USDCv3, and Steakhouse USDC strategy exposure in the curated and live reserve configuration",
        "Scoring weights, thresholds, reserve risks, and live reserve adapter behavior are unchanged",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.16",
      title: "Follow-up freezability classification audit",
      date: "2026-05-06",
      effectiveAt: 1778040000,
      summary:
        "A follow-up review of six disputed `Freezable: No` classifications moves HomeCoin to `Possible` and leaves the other reviewed assets unchanged.",
      impact: [
        "HomeCoin now resolves as `Freezable: Possible` because the holder-facing HOME token is a transparent upgradeable proxy with an active proxy-admin upgrade surface",
        "HBD, vCRED, Freedom Dollar, LUAUSD, and NXUSD remain `Freezable: No` after reviewing their native protocol or verified contract surfaces for freeze, blacklist, pause, denylist, arbitrary burn, or upgrade controls",
        "Owner mint authority and user/allowance burn functions remain supply-control signals, not freeze signals, unless the contract also exposes holder-facing transfer gates, arbitrary burns, blacklist controls, or mutable holder-control surfaces",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "7.15",
      title: "Direct freezability metadata audit",
      date: "2026-05-05",
      effectiveAt: 1777953600,
      summary:
        "The resolved `Freezable: No` cohort was reviewed against token-level freeze, denylist, blacklist, pause, and role-burn controls, moving confirmed direct-control assets out of the unfreezable bucket.",
      impact: [
        "JupUSD, eSui Dollar, MAI, JUSD, Alpha Partner USDA, Ring USDR, DOC, USDRIF, and Nest inALPHA now resolve as direct `Freezable: Yes` when their holder-facing token or vault exposes freeze, denylist, blacklist, or arbitrary role-burn controls",
        "sBOLD and Enosys CDP now resolve as `Freezable: Possible` because the audited contracts expose direct vault pause or mutable branch-control surfaces rather than a current address-level blacklist",
        "The remaining resolved `No` cohort was left unchanged where no direct holder-facing freeze, blacklist, pause, denylist, or arbitrary burn surface was confirmed",
      ],
      commits: [],
      reconstructed: false,
    },
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
];
