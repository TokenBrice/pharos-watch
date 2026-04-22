import { createMethodologyVersion, toMethodologyVersionLabel } from "./methodology-version";

const redemptionBackstop = createMethodologyVersion({
  currentVersion: "3.992",
  changelogPath: "/methodology/#safety-scores-methodology",
  changelog: [
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
        "The \"strong live-direct route\" predicate is now defined once and reused by both the report-card liquidity consumer and the backstop builder, with inline rationale on route family caps and new boundary test coverage.",
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
        "Effective exit formula changed from `max(dex, dex × 0.55 + redemption × 0.45)` to `max(dex, redemption) + min(dex, redemption) × 0.10` — the best exit path dominates and a second path earns a modest diversification bonus",
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
    {
      version: "2.9",
      title: "Semantics correction for non-deterministic HOLLAR exit",
      date: "2026-03-24",
      effectiveAt: 1774364400,
      summary:
        "A route-semantics review removes one overstated redemption path and explicitly leaves several harder assets outside medium-confidence coverage until a credible holder backstop is established.",
      impact: [
        "HOLLAR is no longer modeled as a `psm-swap` redemption route because the Hydration Stability Module only guarantees buying HOLLAR from the facility, while protocol buybacks of HOLLAR remain opportunistic rather than holder-deterministic",
        "The harder follow-up set led to no new medium-confidence additions for crvUSD, sUSD, MIM, or USDU Finance because current public materials still do not establish a primary redemption rail comparable to the existing modeled route families",
        "This keeps redemption coverage honest by preferring uncovered or low-coverage states over overstated direct-exit semantics",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.8",
      title: "Second medium-confidence redemption cleanup tranche",
      date: "2026-03-24",
      effectiveAt: 1774360800,
      summary:
        "A second cleanup tranche upgrades the best non-top-100 low-confidence routes where Pharos already had sufficient issuer, reserve, or queue-redemption evidence to stop relying on heuristics.",
      impact: [
        "cUSD, cEUR, ALUSD, and AZND now use reviewed eventual or reserve-backed redemption semantics instead of heuristic capacity ratios",
        "USDA now carries a reviewed issuer-redemption route, while pUSD Plume now uses live reserve metadata with a documented 1:1 USDC fallback instead of a generic low-confidence issuer assumption",
        "Names whose route semantics are still genuinely unresolved, such as crvUSD, sUSD, MIM, and HOLLAR, remain outside this tranche rather than being promoted on weak evidence",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.7",
      title: "Buffer-backed medium-confidence redemption tranche",
      date: "2026-03-24",
      effectiveAt: 1774353600,
      summary:
        "A follow-up tranche promotes the remaining cleanest heuristic routes by tying their capacity bounds to already-curated stable redemption buffers or direct full-reserve rails.",
      impact: [
        "USDD, LISUSD, reUSD, USR, USDF, DUSD, USP, and BUCK now use reviewed documented-bound capacity instead of generic heuristic ratios because Pharos already tracks explicit stable redemption buffers for those routes",
        "msUSD and fxUSD now carry reviewed direct-redemption semantics rather than unresolved low-confidence defaults, reflecting Main Street's full USDC reserve rail and f(x)'s documented collateral redemption path",
        "Routes whose reserve stack still lacks a clearly bounded redeemable stable buffer, such as YUSD, USN, and UTY, intentionally remain low-confidence until the evidence improves",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.6",
      title: "Moderate-effort redemption confidence tranche",
      date: "2026-03-23",
      effectiveAt: 1774224000,
      summary:
        "A moderate-effort tranche reviews a final group of already-modeled lower-confidence routes where Pharos now has stronger primary redemption semantics, but not yet protocol-native live instant-buffer telemetry across the full set.",
      impact: [
        "DOLA and JupUSD now treat their published stable-buffer bounds as reviewed documented-capacity inputs instead of leaving those ratios in the heuristic bucket",
        "rwaUSDi, mTBILL, MUSD, USDN, and YZUSD now use reviewed redemption semantics with documented-bound capacity instead of generic low-confidence placeholders, while YUSD, USN, and UTY keep conservative bounded-capacity assumptions because their delta-neutral collateral stacks still lack explicit published live buffers",
        "The documented-bound subset now contributes medium-confidence redemption evidence, while the reviewed delta-neutral routes stay visible-only until Pharos has explicit buffer bounds or live telemetry",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.5",
      title: "Reviewed docs-backed quick-win redemption tranche",
      date: "2026-03-23",
      effectiveAt: 1774306800,
      summary:
        "A docs-backed quick-win tranche upgrades nine existing low-confidence redemption routes where the remaining blocker was heuristic capacity or stale access and fee assumptions rather than missing telemetry.",
      impact: [
        "avUSD, cUSD, USDu, cgUSD, HONEY, EUSD, AID, OUSD, and USBD now use reviewed documented-bound redemption capacity instead of staying low-confidence under heuristic supply models",
        "USDu and AID now reflect whitelist-gated direct redemption access, while cgUSD and AID also disclose reviewed live fee assumptions from official docs",
        "These routes still do not claim a separately measured live instant buffer, but they now contribute medium-confidence redemption evidence across roughly half a billion dollars of additional tracked market cap",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.4",
      title: "Maple syrup withdrawal route correction",
      date: "2026-03-23",
      effectiveAt: 1774303200,
      summary:
        "Maple's syrupUSDC and syrupUSDT routes now model the documented withdrawal queue instead of an overstated near-instant redemption buffer.",
      impact: [
        "syrupUSDC and syrupUSDT now use reviewed queue-redemption semantics with documented-bound eventual capacity rather than a heuristic 30% immediate buffer assumption",
        "Access is now modeled as whitelisted onchain, reflecting Maple's PoolPermissionManager gating for `requestRedeem` and `redeem` calls",
        "These routes now contribute medium-confidence redemption evidence while preserving Maple's documented FIFO processing and potential multi-day settlement delay",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.3",
      title: "Reviewed lower-cap redemption cleanup tranche",
      date: "2026-03-23",
      effectiveAt: 1774296000,
      summary:
        "A small lower-cap cleanup tranche upgrades Pleasing and Apyx routes from generic heuristics to reviewed redemption semantics without adding new live telemetry assumptions.",
      impact: [
        "PUSD and PGOLD now use reviewed documented-bound redemption routes tied to Pleasing's published off-ramp and physical-delivery docs instead of generic heuristic issuer assumptions",
        "apxUSD now reflects the documented whitelist-gated mint/redeem rail rather than a generic permissionless stablecoin-redeem assumption",
        "These routes still do not claim a separately measured live instant buffer, but they now contribute medium-confidence redemption evidence instead of remaining low-confidence heuristics",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.2",
      title: "Live-buffer routes for Ethena and Falcon synthetics",
      date: "2026-03-23",
      effectiveAt: 1774292400,
      summary:
        "USDe and USDf now reuse live reserve telemetry for current redeemable stable buffers, turning two large synthetic-dollar gaps into reviewed route coverage.",
      impact: [
        "USDe now models the whitelisted direct mint-and-redeem rail documented by Ethena, with fresh live Liquid Cash telemetry used as the current redeemable stable buffer and a conservative 0.5% fallback bound when telemetry is unavailable",
        "USDf now models Falcon's KYC-only queued redemption route with a live stablecoin-buffer input from Falcon's transparency feed and a reviewed zero protocol-fee assumption based on Falcon docs",
        "These routes materially expand medium-confidence redemption coverage without pretending either protocol has a permanently fixed instant-exit buffer",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.1",
      title: "Mid-cap route correction and review tranche",
      date: "2026-03-23",
      effectiveAt: 1774288800,
      summary:
        "A mid-cap tranche adds missing USX, USDa, and M redemption configs while correcting USD.AI and NUSD onto reviewed routes that better match their protocol docs.",
      impact: [
        "USX, USDa, and M now carry reviewed redemption routes instead of remaining uncovered, and NUSD now uses reviewed documented-bound queue semantics rather than a generic 20% heuristic",
        "USD.AI now models the base token's direct burn-and-withdraw stablecoin rail instead of inheriting the slower sUSDai unstaking assumptions",
        "These routes still do not claim a separately measured live instant buffer, but they materially expand medium-confidence redemption coverage across the mid-cap queue",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.0",
      title: "Third lower-cap redemption review tranche",
      date: "2026-03-23",
      effectiveAt: 1774285200,
      summary:
        "A third lower-cap review tranche upgrades more issuer-style routes from heuristic supply-full modeling to reviewed documented-bound capacity and corrects frxUSD onto its direct onchain stablecoin redemption rail.",
      impact: [
        "thBILL, XAUm, USDGO, and USA₮ now carry reviewed documented-bound eventual redemption capacity instead of generic heuristic supply-full modeling",
        "XAUm now discloses a reviewed 25 bps redemption fee and T+3 settlement expectations, while USDGO now uses the reviewed zero-fee StableHub exchange rail documented by OSL",
        "frxUSD now models the direct onchain USDC mint/redeem contract path as a reviewed stablecoin-redeem route instead of sitting in a generic offchain issuer bucket",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.9",
      title: "Second lower-cap issuer review tranche",
      date: "2026-03-23",
      effectiveAt: 1774281600,
      summary:
        "A second lower-cap review tranche upgrades more issuer-backed routes from heuristic supply-full modeling to reviewed documented-bound redemption capacity, with targeted fee and settlement corrections.",
      impact: [
        "USDH, FIDD, AEUR, USDX, USDM, SBC, EURR, USDR, WUSD, and AUDD now carry reviewed documented-bound eventual redemption capacity instead of generic heuristic supply-full modeling",
        "USDM and AEUR now disclose reviewed non-instant settlement expectations from issuer materials, while USDH now carries an explicit fee-free reviewed route and SBC now uses reviewed pricing language instead of an undocumented fee assumption",
        "These routes remain eventual-only issuer exits without a separately measured immediate redeemable buffer, but they now qualify as medium-confidence redemption evidence instead of low-confidence heuristics",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.8",
      title: "Expanded reviewed lower-cap issuer redemption coverage",
      date: "2026-03-23",
      effectiveAt: 1774274400,
      summary:
        "A lower-cap review tranche now upgrades multiple issuer-backed and tokenized-cash routes from heuristic supply-full modeling to reviewed documented-bound redemption capacity.",
      impact: [
        "CASH, MNEE, USDP, GUSD, XUSD, XSGD, USDQ, EURQ, EURe, EURI, TBILL, EURCV, and USDCV now carry reviewed documented-bound eventual redemption capacity instead of generic heuristic supply-full modeling",
        "TBILL, EURI, EURCV, and USDCV now also disclose reviewed non-instant settlement constraints from issuer documentation",
        "These routes remain eventual-only and do not claim a separately measured immediate redeemable buffer, but they can now resolve medium confidence instead of low",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.7",
      title: "Sky LitePSM routes now use live PSM capacity",
      date: "2026-03-23",
      effectiveAt: 1774270800,
      summary:
        "Sky DAI/USDS routes now score against fresh live PSM USDC capacity from reserve telemetry, and infiniFi IUSD now carries a fixed zero-fee redemption model.",
      impact: [
        "DAI and USDS use current Sky PSM USDC balance as dynamic immediate redemption capacity when fresh live reserve metadata is available",
        "When Sky live metadata is unavailable or stale, those routes fall back to the prior reviewed 33% heuristic instead of becoming unrated",
        "IUSD now uses a fixed zero-fee redemption model, allowing its existing dynamic-capacity queue route to resolve high confidence",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.6",
      title: "Reviewed full-supply redemption routes can now be documented-bound",
      date: "2026-03-23",
      effectiveAt: 1774267200,
      summary:
        "Reviewed issuer and direct-redeem routes can now use documented-bound eventual-only capacity when official terms establish full-supply redeemability without a separately measured immediate buffer.",
      impact: [
        "Multiple issuer and direct-redeem routes now resolve capacity confidence as documented-bound instead of heuristic after source review",
        "These routes stay eventual-only and do not claim a separately measured immediate redeemable buffer",
        "Dynamic immediate-capacity telemetry is still required for high-confidence uplift on routes where current buffer size matters operationally",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.5",
      title: "Fresh live-metadata gating and clearer route provenance",
      date: "2026-03-22",
      effectiveAt: 1774222200,
      summary:
        "Reserve-backed redemption routes now stop scoring against stale live metadata, the API methodology envelope tracks stored snapshot rows, and detail surfaces disclose clearer source provenance.",
      impact: [
        "Reserve-sync capacity now requires a fresh authoritative live snapshot; stale metadata falls back conservatively or leaves the route unrated",
        "GHO normalizes current tracked GSM buy fees into redemption fee telemetry, while the API methodology version now reflects the latest stored row version instead of the live code constant",
        "Detail pages now show reviewed-vs-fallback source provenance, and Honey is modeled as a basket exit under stress-state redemption semantics",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.4",
      title: "Live Liquity fee telemetry for formula routes",
      date: "2026-03-22",
      effectiveAt: 1774191600,
      summary:
        "Formula-based Liquity redemption routes can now consume current on-chain fee telemetry from live reserve sync instead of relying only on the generic reviewed-formula bucket.",
      impact: [
        "LUSD and BOLD live reserve adapters now record current redemption fee bps from official protocol contracts",
        "Redemption backstop cost scoring uses live fee bps when that telemetry is available, while keeping the route labeled as a formula model",
        "If live fee telemetry is missing, these routes fall back to the prior reviewed-formula scoring bucket",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.3",
      title: "Documented-bound full-system redemption for Liquity routes",
      date: "2026-03-22",
      effectiveAt: 1774184400,
      summary:
        "Immutable Liquity-style routes can now be marked documented-bound when protocol mechanics establish full-system redeemability, while still preserving eventual-only capacity semantics.",
      impact: [
        "LUSD and BOLD now resolve capacity confidence as documented-bound instead of heuristic",
        "These routes stay eventual-only and do not claim a separately measured immediate redeemable buffer",
        "Reviewed Liquity-style fee formulas remain dynamic formula inputs rather than fixed bps placeholders",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.2",
      title: "Failure-safe snapshots and evidence-aware capacity semantics",
      date: "2026-03-22",
      effectiveAt: 1774137600,
      summary:
        "Redemption backstop snapshots now materialize failed rows safely, separate eventual redeemability from immediate capacity, and reuse more live reserve metadata.",
      impact: [
        "Failed per-coin syncs now write fresh failed rows instead of leaving stale resolved rows live",
        "`supply-full` routes no longer expose full current supply as immediate capacity on the detail surface",
        "OpenEden USDO, GHO, and wsrUSD now reuse live reserve metadata for immediate redeemable capacity; infiniFi ratio now uses supply as the denominator",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.1",
      title: "Fee-source coverage expansion",
      date: "2026-03-20",
      effectiveAt: 1773964800,
      summary:
        "Expanded redemption-fee coverage with docs-backed fixed fees, conditional fee descriptions, and clearer handling of issuer routes without a single public fee schedule.",
      impact: [
        "Redemption backstop entries now expose a fee description alongside bounded fee bps when available",
        "Multiple assets now carry docs-backed fixed fee inputs instead of generic unknown-fee handling",
        "Routes without a single public numeric fee now surface explicit variable or undisclosed fee descriptions instead of false precision",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.0",
      title: "Initial redemption backstop scoring",
      date: "2026-02-28",
      effectiveAt: 1772272800,
      summary:
        "First operational release of the redemption backstop scoring framework with effective-exit assessment.",
      impact: [
        "Introduced per-stablecoin redemption route configs with access, settlement, execution, and output-asset scoring",
        "Effective-exit score combined capacity utilization with weighted route-family scores",
        "Report card safety dimension now includes redemption backstop component",
      ],
      commits: [],
      reconstructed: true,
    },
  ],
});

/** Canonical Redemption Backstop methodology version (no "v" prefix). */
export const REDEMPTION_BACKSTOP_VERSION = redemptionBackstop.currentVersion;

/** Display-ready Redemption Backstop methodology version (with "v" prefix). */
export const REDEMPTION_BACKSTOP_VERSION_LABEL = redemptionBackstop.versionLabel;

/** Public methodology route for Redemption Backstop methodology. */
export const REDEMPTION_BACKSTOP_METHODOLOGY_PATH = redemptionBackstop.changelogPath;

/** Resolve Redemption Backstop methodology version active at a given Unix timestamp (seconds). */
export const getRedemptionBackstopVersionAt = redemptionBackstop.getVersionAt;

/** Display-ready label for a historical Redemption Backstop methodology version. */
export const toRedemptionBackstopVersionLabel = toMethodologyVersionLabel;
