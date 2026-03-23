import { createMethodologyVersion } from "./methodology-version";

const redemptionBackstop = createMethodologyVersion({
  currentVersion: "1.7",
  changelogPath: "/methodology/#safety-scores-methodology",
  changelog: [
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
