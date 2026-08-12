import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const REDEMPTION_BACKSTOP_V2: readonly MethodologyChangelogEntry[] = [
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
      effectiveAt: 1774306801,
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
];
