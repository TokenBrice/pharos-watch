import type { SeeAlsoLink } from "@/components/see-also-footer";

/**
 * Per-page see-also mappings. These are hand-curated and act as the IA graph
 * between long-form pages and the live data they explain. Each page caps at
 * 4 outbound links per the council's discoverability rule.
 *
 * Keys are either the route path (with trailing slash) or — for methodology
 * sub-sections that share a single `/methodology/` route — the section's
 * anchor-prefixed key (e.g. `/methodology#safety-scores`).
 */
export const SEE_ALSO_GRAPH: Record<string, ReadonlyArray<SeeAlsoLink>> = {
  // ── Methodology sections (anchored within /methodology/) ──────────────
  "/methodology#lifecycle-phases": [
    {
      href: "/cemetery/",
      label: "Stablecoin cemetery",
      description: "Frozen and decommissioned assets, archived data.",
    },
    {
      href: "/upcoming/",
      label: "Upcoming launches",
      description: "Pre-launch coins with milestone tracking.",
    },
    {
      href: "/coverage/",
      label: "Coverage matrix",
      description: "Which features Pharos can show per asset.",
    },
  ],
  "/methodology#pricing-pipeline": [
    {
      href: "/depeg/",
      label: "Depeg tracker",
      description: "Where the pricing pipeline's verdicts surface.",
    },
    {
      href: "/methodology/pricing-pipeline-changelog/",
      label: "Pricing pipeline changelog",
      description: "Version history of source weighting and cutoffs.",
    },
    {
      href: "/liquidity/",
      label: "DEX liquidity",
      description: "The on-chain depth pricing leans on as fallback.",
    },
  ],
  "/methodology#stability-index": [
    {
      href: "/stability-index/",
      label: "PSI live tracker",
      description: "The market-wide stability index in real time.",
    },
    {
      href: "/methodology/stability-index-changelog/",
      label: "PSI changelog",
      description: "Version history for the index formula.",
    },
    {
      href: "/timeline/",
      label: "Stability timeline",
      description: "PSI trajectory across years of market history.",
    },
  ],
  "/methodology#safety-scores": [
    {
      href: "/safety-scores/",
      label: "Safety Score tracker",
      description: "Live grades across every tracked coin.",
    },
    {
      href: "/methodology/scoring-changelog/",
      label: "Safety Score changelog",
      description: "Version history of weights and dimensions.",
    },
    {
      href: "/about/bluechip/",
      label: "Bluechip designation",
      description: "The strict-floor classification rules.",
    },
    {
      href: "/dependency-map/",
      label: "Dependency map",
      description: "The graph Dependency Risk scores against.",
    },
  ],
  "/methodology#infrastructure": [
    {
      href: "/chains/",
      label: "Chain health tracker",
      description: "Per-chain reliability scores.",
    },
    {
      href: "/methodology/chain-health-changelog/",
      label: "Chain health changelog",
      description: "Version history of the infrastructure rubric.",
    },
    {
      href: "/dependency-map/",
      label: "Dependency map",
      description: "Coin-to-chain and coin-to-coin dependencies.",
    },
  ],
  "/methodology#liquidity": [
    {
      href: "/liquidity/",
      label: "Liquidity tracker",
      description: "Live DEX depth scores across every coin.",
    },
    {
      href: "/methodology/liquidity-score-changelog/",
      label: "Liquidity changelog",
      description: "Version history of weights and source rules.",
    },
    {
      href: "/coverage/",
      label: "Liquidity coverage",
      description: "Which coins have eligible DEX coverage.",
    },
  ],
  "/methodology#mint-burn-flow": [
    {
      href: "/flows/",
      label: "Mint/burn flows",
      description: "Live issuance and redemption pressure.",
    },
    {
      href: "/methodology/mint-burn-flow-changelog/",
      label: "Flow methodology changelog",
      description: "Version history of the flow rubric.",
    },
    {
      href: "/freezewatch/",
      label: "Freeze watch",
      description: "Where chain-level flow shocks surface.",
    },
  ],
  "/methodology#yield-intelligence": [
    {
      href: "/yield/",
      label: "Yield tracker",
      description: "Live APY surface and benchmark drift.",
    },
    {
      href: "/methodology/yield-changelog/",
      label: "Yield methodology changelog",
      description: "Version history of yield-risk weights.",
    },
  ],
  "/methodology#pegscore-dews": [
    {
      href: "/depeg/",
      label: "Depeg tracker",
      description: "Where DEWS bands are surfaced live.",
    },
    {
      href: "/methodology/depeg-changelog/",
      label: "DEWS changelog",
      description: "Version history of the early-warning system.",
    },
    {
      href: "/stability-index/",
      label: "PSI tracker",
      description: "Market-wide stress signal DEWS feeds.",
    },
  ],
  "/methodology#contagion-stress-test": [
    {
      href: "/dependency-map/",
      label: "Dependency map",
      description: "The graph the stress test propagates through.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Score tracker",
      description: "See the projected stress grades on each coin.",
    },
  ],
  "/methodology#blacklist-tracker": [
    {
      href: "/freezewatch/",
      label: "Freeze watch",
      description: "Live blacklist and freeze events.",
    },
    {
      href: "/methodology/blacklist-tracker-changelog/",
      label: "Blacklist changelog",
      description: "Version history of event taxonomy.",
    },
  ],
  "/methodology#chain-health": [
    {
      href: "/chains/",
      label: "Chain health",
      description: "Per-chain reliability scores and alerts.",
    },
    {
      href: "/methodology/chain-health-changelog/",
      label: "Chain health changelog",
      description: "Version history of chain scoring inputs.",
    },
    {
      href: "/dependency-map/",
      label: "Dependency map",
      description: "Coin-to-chain dependency view.",
    },
  ],

  // ── Learn ─────────────────────────────────────────────────────────────
  "/learn/mechanisms/": [
    {
      href: "/methodology/",
      label: "Pharos methodology",
      description: "How each mechanism shows up in scoring.",
    },
    {
      href: "/stablecoins/",
      label: "Stablecoin taxonomy",
      description: "Group coins by peg, backing, and governance.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Score tracker",
      description: "See mechanisms graded under stress.",
    },
    {
      href: "/cemetery/",
      label: "Cemetery",
      description: "Mechanisms that did not survive.",
    },
  ],
  "/learn/mechanisms/fiat-cash/": [
    {
      href: "/stablecoins/backing/rwa/",
      label: "RWA-backed coins",
      description: "Browse tracked stablecoins backed by cash, Treasuries, and other real-world assets.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Score tracker",
      description: "Compare fiat-cash grades head-to-head.",
    },
    {
      href: "/freezewatch/",
      label: "Freeze watch",
      description: "Issuer-controlled freezes hit here first.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How custody and reserves enter the score.",
    },
  ],
  "/learn/mechanisms/tbill/": [
    {
      href: "/yield/",
      label: "Yield tracker",
      description: "Tokenized T-bill yields, ranked.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How NAV tokens are graded separately.",
    },
    {
      href: "/coverage/",
      label: "Coverage matrix",
      description: "Which T-bill coins have reserves coverage.",
    },
  ],
  "/learn/mechanisms/cdp/": [
    {
      href: "/depeg/",
      label: "Depeg tracker",
      description: "CDP peg behavior under stress.",
    },
    {
      href: "/liquidity/",
      label: "Liquidity tracker",
      description: "Exit depth for CDP coins.",
    },
    {
      href: "/dependency-map/",
      label: "Dependency map",
      description: "Underlying collateral graph.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How collateral and liquidations enter scores.",
    },
  ],
  "/learn/mechanisms/synthetic-delta-neutral/": [
    {
      href: "/yield/",
      label: "Yield tracker",
      description: "Funding-rate yields under stress.",
    },
    {
      href: "/depeg/",
      label: "Depeg tracker",
      description: "How delta-neutral coins behave when basis flips.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How synthetic exposure is scored.",
    },
  ],
  "/learn/mechanisms/algorithmic/": [
    {
      href: "/cemetery/",
      label: "Cemetery",
      description: "Algorithmic designs that did not survive.",
    },
    {
      href: "/depeg/",
      label: "Depeg tracker",
      description: "Where algorithmic failures show up live.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "Why algorithmic coins get a structural penalty.",
    },
  ],
  "/learn/mechanisms/rwa-credit-fund/": [
    {
      href: "/yield/",
      label: "Yield tracker",
      description: "Credit-fund yields with risk flags.",
    },
    {
      href: "/coverage/",
      label: "Coverage matrix",
      description: "Which credit-fund coins have data coverage.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How NAV wrappers are scored.",
    },
  ],

  // ── About ─────────────────────────────────────────────────────────────
  "/about/principles/": [
    {
      href: "/about/editorial/",
      label: "Editorial policy",
      description: "How AI-authored content is reviewed and labeled.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "The scoring functions the principles guide.",
    },
    {
      href: "/funding/",
      label: "Funding ledger",
      description: "Inbound side of the same accountability.",
    },
    {
      href: "/about/bluechip/",
      label: "Bluechip designation",
      description: "A principle codified into the rubric.",
    },
  ],
  "/about/editorial/": [
    {
      href: "/about/principles/",
      label: "Pharos principles",
      description: "The axioms behind the policy.",
    },
    {
      href: "/digest/",
      label: "Daily digest archive",
      description: "Editorial output, dated and reviewed.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "The computed half of every editorial claim.",
    },
  ],

  // ── API & coverage ────────────────────────────────────────────────────
  "/api/": [
    {
      href: "/about/api/",
      label: "API reference",
      description: "Endpoint contracts, OpenAPI, and Postman.",
    },
    {
      href: "/coverage/",
      label: "Coverage matrix",
      description: "What data is available per coin.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "Define every field the API returns.",
    },
  ],
  "/coverage/": [
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How each tracked feature is computed.",
    },
    {
      href: "/api/",
      label: "API access",
      description: "Pull coverage programmatically.",
    },
    {
      href: "/upcoming/",
      label: "Upcoming launches",
      description: "Pre-launch assets excluded from coverage.",
    },
    {
      href: "/cemetery/",
      label: "Cemetery",
      description: "Archived assets excluded from live coverage.",
    },
  ],
};
