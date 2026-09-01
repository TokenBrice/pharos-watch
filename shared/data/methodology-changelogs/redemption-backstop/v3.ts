import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const REDEMPTION_BACKSTOP_V3: readonly MethodologyChangelogEntry[] = [
    {
      version: "3.997",
      title: "Redemption coverage expansion and documented-bound upgrades",
      date: "2026-05-12",
      effectiveAt: 1778594400,
      summary:
        "Reviewed redemption coverage expands across issuer rails, NAV wrappers, queue exits, PSM routes, collateral redemptions, and protocol conversions, while older reviewed routes with explicit terms are promoted from heuristic to documented-bound capacity.",
      impact: [
        "BENJI, WTGXX, VBILL, JTRSY, USTBL, EUTBL, bIB01, bC3M, CADD, MYRC, KRWQ, and SOFID now carry source-reviewed offchain issuer or platform redemption routes",
        "stUSDS, stcUSD, sBOLD, msY, yUSD, sAID, and ZYS now carry source-reviewed wrapper, vault, or protocol-conversion routes",
        "ACRED, bUSD0, IST, uUSD, ZSD, hyUSD, and fUSD now carry source-reviewed queued, PSM, collateral, or protocol-conversion routes",
        "ZARP, CETES, CGO, DGLD, DUSD Alto, USSD, and USDP move from low-confidence heuristic capacity into documented-bound coverage based on reviewed public route terms",
        "Coverage rises to 264 configured redemption routes, with route-family totals now at 124 offchain-issuer, 57 stablecoin-redeem, 32 collateral-redeem, 34 queue-redeem, 10 psm-swap, and 7 basket-redeem",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.996",
      title: "Stablecoin audit route coverage expansion",
      date: "2026-05-12",
      effectiveAt: 1778590800,
      summary:
        "Comprehensive review of recently added stablecoins adds source-reviewed redemption routes for audited wrappers, Nest vaults, DUSD, mRe7YIELD, DJED, and SMARDEX USDN while refreshing OnRe and Hyperbeat route terms.",
      impact: [
        "USDCx, Spark Savings USDT/USDC, Gauntlet USDC Core/Prime, Yearn yvUSDC, Aave sGHO, and the MEV Capital Falcon senior tranche now carry modeled protocol redemption or NAV-exit routes",
        "DUSD and mRe7YIELD now carry offchain/platform redemption routes; DJED and SMARDEX USDN now carry collateral-redemption routes; nTBILL, nBASIS, nOPAL, and nWISDOM now carry queued Nest redemption routes",
        "OnRe redemption terms now reflect weekly capacity up to 2.5% NAV and a 25 bps fee, while hbUSDT reflects instant 0.5% or classic no-fee redemption timing",
        "Coverage rises to 238 configured redemption routes, with route-family totals now at 112 offchain-issuer, 50 stablecoin-redeem, 28 collateral-redeem, 32 queue-redeem, 9 psm-swap, and 7 basket-redeem",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.995",
      title: "Non-USD and commodity coverage expansion",
      date: "2026-05-11",
      effectiveAt: 1778457600,
      summary:
        "Seven newly tracked non-USD and commodity stablecoins now publish source-reviewed redemption routes, including Mento CDP collateral exits for GBPm, JPYm, and CHFm.",
      impact: [
        "GLDY, VNXAU, XAGm, and EUROe now carry documented-bound offchain issuer redemption routes with reviewed source links and access, fee, settlement, and capacity caveats",
        "GBPm, JPYm, and CHFm now carry collateral-redeem routes into USDm-backed Mento CDP collateral, aligned with the new Mento CDP reserve-sync mode",
        "Coverage rises to 202 configured redemption routes, with route-family totals now at 106 offchain-issuer and 26 collateral-redeem",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.994",
      title: "Conservative queued coverage for stkGHO and USDRIF",
      date: "2026-05-10",
      effectiveAt: 1778371200,
      summary:
        "Aave Umbrella stkGHO and RIF On Chain USDRIF now publish source-reviewed queued redemption routes with eventual-only capacity semantics.",
      impact: [
        "stkGHO is modeled as a queued wrapper exit into GHO through Aave Umbrella's cooldown and withdrawal-window process, with slashing risk retained in route notes",
        "USDRIF is modeled as a queued RIF-collateral redemption route because broad holder redemption is settlement-cycle based, while outside-settlement redemption is limited to free USDRIF",
        "Both routes use documented-bound eventual-only capacity, so they remain visible as reviewed coverage without creating immediate live-capacity evidence for Safety Score liquidity uplift",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.993",
      title: "Live redemption telemetry gating and constraints",
      date: "2026-05-10",
      effectiveAt: 1778371200,
      summary:
        "Live redemption capacity now carries adapter-declared capacity/freshness context through the API, fails closed on unverified nested freshness unless explicitly allowlisted, and applies live daily limits as scoring capacity constraints.",
      impact: [
        "Reserve-sync redemption routes now persist and expose live capacity kind, freshness kind, source timestamp/URLs, settlement delay, queue depth, daily limit, minimum redeem size, and live holder eligibility when adapters emit them",
        "Nested live redemption freshness marked `unverified` is no longer scoreable by default; only route-specific allowlisted lower-bound cases can continue to score while retaining the unverified context",
        "Adapter-emitted daily redemption limits cap scoring capacity while raw immediate capacity remains visible for context",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.992",
      title: "Tracked wrapper routes inherit severe parent depegs",
      date: "2026-04-22",
      effectiveAt: 1776816000,
      summary:
        "Configured tracked wrappers now inherit a severe active-depeg impairment from their parent stablecoin when their peg is explicitly authored through that same parent link.",
      impact: [
        "Wrapper routes whose metadata keeps `pegReferenceId === variantOf` now reuse the parent's severe active-depeg exercisability gate instead of remaining scoreable when only the parent has the open depeg row",
        "This inherited impairment is scoped only to wrappers that already have a redemption-backstop config in the registry; the rollout does not add new route coverage by itself",
        "Safety Score active-depeg caps and Redemption Backstop route impairment now stay aligned for tracked wrappers on the same quarter-hourly/4-hourly runtime clocks",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.991",
      title: "AUDF and DOC route coverage",
      date: "2026-04-21",
      effectiveAt: 1776729600,
      summary:
        "Forte AUD and Dollar on Chain now publish reviewed redemption routes, extending modeled coverage to one additional offchain issuer rail and one additional BTC-collateral redemption rail.",
      impact: [
        "AUDF now carries a documented-bound offchain-issuer redemption route sourced from Forte's PDS, legal terms, and reserve-report page",
        "DOC now carries a permissionless collateral-redeem route into RBTC sourced from Money On Chain protocol docs",
        "Coverage rises to 179 configured redemption routes, with route-family totals now at 93 offchain-issuer and 23 collateral-redeem",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.99",
      title: "Flat/RWA issuer coverage expansion",
      date: "2026-04-20",
      effectiveAt: 1776643200,
      summary:
        "Six newly tracked flat/RWA issuer assets join modeled redemption coverage, including whitelisted collateral redemption for Alloy aUSDT and five documented issuer routes.",
      impact: [
        "USDon, USDsui, BRLV, USDGLO, and AUDM now publish documented-bound offchain-issuer redemption routes with reviewed source links and access/settlement caveats",
        "Alloy aUSDT now publishes a whitelisted collateral-redemption route into XAUT, while live reserve sync reads its Ethereum vault XAUT balance and aUSDT supply for reserve visibility",
        "Jiritsu JUSD remains excluded because the priced CoinGecko/CMC JUSD asset resolves to a different token and the official Jiritsu token lacks a usable price/depeg source",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.98",
      title: "Capacity-over-supply clamp, coverage expansion, and runtime hardening",
      date: "2026-04-16",
      effectiveAt: 1776297600,
      summary:
        "Live reserve capacity is now clamped to current supply for scoring, 17 new stablecoins join modeled redemption coverage, and several lower-confidence supply-ratio routes are explicitly tagged as heuristic rather than silently relying on uncited ratios.",
      impact: [
        "Live redemption capacity greater than current supply is now clamped to supply for scoring and surfaces an explicit note; previously only the ratio was clamped while the raw USD amount flowed through unchanged",
        "17 new stablecoins added to redemption coverage: dEURO, CJPY, wM, ftUSD, USDz, USDSC, Silk, USDAT, USDnr, BUCK, USDH, BRLA, ctUSD, XO, USDK, USDM, and USDKG, spanning collateral-redeem, stablecoin-redeem, basket-redeem, queue-redeem, and offchain-issuer families",
        "Lower-confidence supply-ratio routes (dusd-dtrinity, yousd-yield-optimizer, uty-xsy) now carry explicit `confidence: heuristic` plus reviewed docs rather than silently defaulting to heuristic with no evidence trail",
        "Fee-score breakpoints extracted to named constants and route notes deduplicated end-to-end",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.97",
      title: "Redemption backstop code deduplication and boundary test coverage",
      date: "2026-04-15",
      effectiveAt: 1776290400,
      summary:
        'The "strong live-direct route" predicate is now defined once and reused by both the report-card liquidity consumer and the backstop builder, with inline rationale on route family caps and new boundary test coverage.',
      impact: [
        "`isStrongLiveDirectRoute` is now a single shared predicate in `shared/lib/redemption-backstop-scoring.ts` consumed by both `scoreLiquidity` and `buildRedemptionBackstopEntry`, removing the prior drift-prone duplicate definitions",
        "Severe-depeg exclusion behavior is now locked in at the exact 2499 / 2500 bps boundary, live-proxy routes are explicitly confirmed not to survive severe depegs even with permissionless atomic execution, and all capacity-score and route-family cap breakpoints are covered by assertions",
        "No coin-facing scoring semantics changed; this release is test coverage, documentation, and code deduplication only",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.96",
      title: "Redemption telemetry validation and route-status fail-closed hardening",
      date: "2026-04-15",
      effectiveAt: 1776276000,
      summary:
        "Live reserve redemption telemetry now fails closed more consistently, and shared config/documentation provenance no longer leaks across expanded route groups.",
      impact: [
        "Paused, degraded, or cohort-limited live route-status telemetry now marks the redemption row impaired instead of publishing a current standalone score",
        "Nested and legacy redemption telemetry fields are validated independently before persistence, preventing malformed nested values from being masked by valid legacy fields",
        "Adapters that are not declared as redemption-capacity sources no longer emit unsupported capacity metadata, and expanded shared route configs now receive per-asset reviewed docs",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.95",
      title: "USTB live Superstate liquidity capacity",
      date: "2026-04-15",
      effectiveAt: 1776272400,
      summary:
        "USTB now combines its existing on-chain NAV reserve proof with Superstate's current public liquidity endpoint for bounded redemption-capacity telemetry.",
      impact: [
        "The `ustb-superstate` route now uses reserve-sync metadata instead of the static full-supply eventual model",
        "The `superstate-liquidity` adapter preserves USTB NAV reserve slices while adding current Circle USD and USDC RedemptionIdle liquidity as capacity",
        "If the Superstate liquidity payload is missing or malformed, USTB remains visible but unrated for redemption capacity rather than using NAV/AUM as immediate liquidity",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.94",
      title: "frxUSD live reserve capacity and route-status guardrails",
      date: "2026-04-15",
      effectiveAt: 1776268800,
      summary:
        "frxUSD now resolves redemption capacity from fresh Frax balance-sheet telemetry, and live redemption route status can flow from reserve adapters into redemption-backstop scoring.",
      impact: [
        "The `frxusd-frax` route now uses reserve-sync metadata instead of the static full-supply eventual model",
        "Frax balance-sheet redemption capacity emits a current stablecoin capacity amount without reusing reserve-composition ratios as supply-relative capacity",
        "Live reserve redemption telemetry can carry route status and provenance so paused or degraded live routes do not silently score as open",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.93",
      title: "Long-tail live redemption adapters",
      date: "2026-04-15",
      effectiveAt: 1776265200,
      summary:
        "Additional long-tail redemption routes now use current live reserve telemetry instead of static eventual-capacity assumptions where public APIs or on-chain reads expose bounded capacity.",
      impact: [
        "Felix feUSD, Nerite USND, and Quill USDQ now use same-run Liquity v2 ActivePool debt as direct bounded redemption capacity",
        "fxUSD now consumes f(x)'s protocol debt balances as live proxy capacity, while USDaf uses Asymmetry's timestamped protocol supply as direct current capacity",
        "JupUSD now consumes its public transparency API for current USDC/USDtb holdings and route-status telemetry, retaining the reviewed 10% buffer only as fallback",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.92",
      title: "BOLD live Liquity v2 branch debt capacity",
      date: "2026-04-15",
      effectiveAt: 1776261600,
      summary:
        "BOLD now uses the Liquity v2 branch adapter's same-run on-chain ActivePool debt as direct redemption-capacity telemetry.",
      impact: [
        "The `bold-liquity` live reserve config now uses `liquity-v2-branches`, which reads branch collateral balances plus ActivePool branch debt",
        "`bold-liquity` now resolves redemption capacity from fresh reserve-sync metadata instead of the static full-supply model",
        "When the Liquity v2 branch snapshot is unavailable or stale, BOLD remains visible but unrated for redemption capacity rather than falling back to an immediate full-supply estimate",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.91",
      title: "LUSD live direct capacity telemetry",
      date: "2026-04-15",
      effectiveAt: 1776258000,
      summary:
        "LUSD now uses the Liquity v1 live reserve adapter's same-run on-chain system debt as direct redemption-capacity telemetry.",
      impact: [
        "The `liquity-v1` adapter now publishes nested `metadata.redemption` capacity from `TroveManager.getEntireSystemDebt()` alongside the existing live redemption fee",
        "`lusd-liquity` now resolves redemption capacity from fresh reserve-sync metadata instead of the static full-supply model",
        "When the Liquity on-chain snapshot is unavailable or stale, LUSD remains visible but unrated for redemption capacity rather than falling back to an immediate full-supply estimate",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.9",
      title: "Normalized redemption telemetry and live capacity adapters",
      date: "2026-04-15",
      effectiveAt: 1776250800,
      summary:
        "Live reserve adapters can now publish normalized redemption telemetry, and Cap cUSD now uses direct vault-capacity telemetry instead of full-supply eventual assumptions.",
      impact: [
        "Reserve-sync redemption routes prefer nested `metadata.redemption` capacity, fee, freshness, and route-status fields while keeping legacy flat metadata readable",
        "Live reserve validation rejects malformed or unsupported redemption telemetry before it can reach redemption-backstop scoring",
        "Cap cUSD now scores against current unpaused available vault balances through the new cap-vault adapter rather than treating full eventual basket redeemability as immediate capacity",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.8",
      title: "Active-depeg exercisability gate",
      date: "2026-04-14",
      effectiveAt: 1776124800,
      summary:
        "Severe active depegs now impair static or non-live-direct redemption routes unless current live-open redemption evidence is available.",
      impact: [
        "Open depeg rows at or above 2500 bps now mark static, documented-bound, live-proxy, issuer/API, queue, and estimated redemption routes as impaired instead of publishing a normal current score",
        "Impaired rows keep route metadata visible but set score and effectiveExitScore to null, lower model confidence, and carry a market-implied route-status reason",
        "Live-direct, dynamic, permissionless, atomic or immediate redemption routes can remain scoreable during severe active depegs because they provide current direct exercisability evidence",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.7",
      title: "Best-path effective exit model replaces weighted blend",
      date: "2026-04-07",
      effectiveAt: 1775570400,
      summary:
        "The effective exit score now uses max(dex, redemption) + diversification bonus instead of a weighted blend that penalized coins with one strong exit path and one weak one.",
      impact: [
        "Effective exit formula changed from `max(dex, dex × 0.55 + redemption × 0.45)` to `max(dex, redemption) + min(dex, redemption) × 0.10`: the best exit path dominates and a second path earns a modest diversification bonus",
        "Redemption-only coins now use the raw redemption backstop score with no cap or discount, removing the previous `min(70, score × 0.75)` penalty; route family caps (offchain-issuer ≤ 65, queue-redeem ≤ 70) remain as guardrails",
        "Coins with strong permissionless redemption (DAI, GHO, frxUSD, LUSD, BOLD) see the largest uplift; DEX-only coins are unaffected; CeFi offchain-issuer coins see modest improvement bounded by route family caps",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.6",
      title: "ZCHF VCHF bridge route added with live bridge-capacity telemetry",
      date: "2026-04-06",
      effectiveAt: 1775484000,
      summary:
        "Frankencoin ZCHF now models its permissionless onchain StablecoinBridge exit into VCHF instead of remaining uncovered in redemption backstops.",
      impact: [
        "`zchf-frankencoin` now uses a reviewed `stablecoin-redeem` route for the public ZCHF -> VCHF burn-and-withdraw bridge contract",
        "The existing Frankencoin collateral-positions reserve adapter now emits the bridge's live VCHF inventory as immediate redeemable capacity telemetry, so fresh hourly reserve sync can drive current bridge-buffer sizing directly",
        "When live bridge telemetry is temporarily unavailable, the route falls back to a conservative reviewed 1.4% bridge-buffer ratio instead of disappearing entirely",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.5",
      title: "Telemetry-aware freshness gate for reserve-sync capacity",
      date: "2026-04-05",
      effectiveAt: 1775397600,
      summary:
        "Adapters that declare capacity telemetry (direct or proxy) or physically emit capacity metadata no longer require scoring-grade freshness evidence to use live capacity data for scoring. The temporal quality is already validated by the isFresh gate.",
      impact: [
        "iUSD-infiniFi now resolves live-proxy capacity confidence from the infiniFi protocol API instead of falling back to the heuristic 15% ratio, restoring medium model confidence and re-enabling backstop contribution to effective exit scoring",
        "Any reserve-sync-metadata route whose adapter provides capacity telemetry but uses unverified freshness mode now scores against live capacity data instead of being silently downgraded to a heuristic fallback",
        "Adapters without declared capacity telemetry or physical capacity metadata still require scoring-grade freshness evidence, preserving the original gate for inferred-capacity routes",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.4",
      title: "USD.AI base-token and sUSDai route split",
      date: "2026-04-04",
      effectiveAt: 1775311200,
      summary:
        "USD.AI no longer overloads the base token and yield token onto one redemption model: base USDai keeps the direct PYUSD-side rail, while sUSDai now has its own documented queued exit.",
      impact: [
        "Base `usdai-usd-ai` remains a permissionless atomic stablecoin-redeem route scoped to the liquid base token rather than to the yield product",
        "New `susdai-usd-ai` now models the documented 30-day queued unstake flow back into USDai instead of inheriting base-token semantics",
        "Because public USD.AI materials do not publish a trustworthy numeric instant-liquidity bound for sUSDai, the new route is scored as documented-bound eventual capacity rather than as a measured immediate buffer",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.3",
      title: "Selective lower-bound recovery for GHO and Reservoir fallback hardening",
      date: "2026-04-04",
      effectiveAt: 1775260800,
      summary:
        "Two reserve-backed redemption routes now recover from the v3.1 trust-boundary tightening without weakening reserve-sync scoring globally.",
      impact: [
        "GHO can again use tracked live GSM backing as an immediate redemption lower bound when reserve sync is degraded only because residual issuance outside the configured GSM set remains aggregated",
        "wsrUSD now falls back to Reservoir's reviewed 25 bps minimum USDC PSM balance when the live balance-sheet API lacks scoring-grade freshness evidence, instead of remaining unrated",
        "Reserve-sync fallback ratios can now preserve reviewed `documented-bound` confidence and basis metadata instead of being forced into the generic heuristic bucket",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.2",
      title: "USD.AI redemption rail wording correction",
      date: "2026-04-03",
      effectiveAt: 1775174400,
      summary:
        "USD.AI's reviewed redemption route now explicitly reflects the live PYUSD-only base-token rail instead of broader multi-stable wording inherited from older docs phrasing.",
      impact: [
        "USD.AI still models base USDai as a permissionless atomic stablecoin-redeem route, but the reviewed route notes and fee text now state that direct mint and redeem are against PYUSD specifically rather than generic supported stablecoins",
        "The slower queue remains scoped to sUSDai unstaking only, preserving the existing base-token route semantics while tightening the evidence trail to the live app flow and current issuer guidance",
        "No live redemption-capacity telemetry is added here because USD.AI's public API does not currently expose a trustworthy base-token redeemable-buffer or redemption-limit feed",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.1",
      title: "Live-capacity truth-boundary hardening and registry cleanup",
      date: "2026-03-30",
      effectiveAt: 1774828800,
      summary:
        "Reserve-backed redemption routes now use stricter live-metadata eligibility, explicit live-direct vs live-proxy confidence, and reviewed source-link guardrails.",
      impact: [
        "Reserve-sync capacity now requires fresh `ok` snapshots, no degrading reserve warnings, scoring-grade freshness evidence, and an adapter that explicitly exposes redeemable-capacity telemetry",
        "Live-backed routes now distinguish `live-direct` from `live-proxy`, and only direct live capacity can resolve high confidence; `pUSD Plume` is corrected back to a reviewed documented-bound issuer rail instead of a fake dynamic route",
        "Reviewed documented-bound and reserve-sync routes now require explicit `docs[]`, unreviewed routes are closed or downgraded, and stored/API snapshot details preserve richer fidelity metadata including capacity basis and live-capacity classification",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.0",
      title: "Issuer and route-review medium-confidence tranche",
      date: "2026-03-24",
      effectiveAt: 1774368000,
      summary:
        "A final low-effort tranche upgrades the remaining easy issuer-style and route-reviewed assets from heuristic defaults to documented-bound redemption coverage.",
      impact: [
        "EURS, GYEN, CADC, the reviewed VNX fiat tokens, TRYB, tGBP, JPYC, AxCNH, IDRT, EUROP, and EURAU now use reviewed documented-bound issuer redemption semantics instead of generic heuristic issuer defaults",
        "FPI and GYD now use reviewed documented-bound collateral-redemption semantics rather than remaining low-confidence placeholder routes",
        "This tranche adds medium-confidence coverage without introducing new adapter work or changing the route bar for the harder semantics-blocked assets",
      ],
      commits: [],
      reconstructed: false,
    },
];
