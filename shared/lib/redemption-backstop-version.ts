import { createMethodologyVersion } from "./methodology-version";

const redemptionBackstop = createMethodologyVersion({
  currentVersion: "1.16",
  changelogPath: "/methodology/#safety-scores-methodology",
  changelog: [
    {
      version: "1.16",
      title: "Moderate-effort redemption confidence tranche",
      date: "2026-03-23",
      effectiveAt: 1774314000,
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
      version: "1.15",
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
      version: "1.14",
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
      version: "1.13",
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
      version: "1.12",
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
      version: "1.11",
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
      version: "1.10",
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
      effectiveAt: 1773961200,
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
