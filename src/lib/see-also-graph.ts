import type { SeeAlsoLink } from "@/components/see-also-footer-view";
import {
  CLIENT_ROUTE_SEE_ALSO_GRAPH,
  normalizeSeeAlsoPath,
} from "./see-also-graph-client";

const SERVER_ROUTE_SEE_ALSO_GRAPH: Readonly<Record<string, ReadonlyArray<SeeAlsoLink>>> = {
  "/coverage/": [
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How each tracked feature is computed.",
    },
    {
      href: "/api/",
      label: "API",
      description: "Pull coverage programmatically.",
    },
    {
      href: "/upcoming/",
      label: "Upcoming",
      description: "Pre-launch assets excluded from coverage.",
    },
    {
      href: "/cemetery/",
      label: "Cemetery",
      description: "Archived assets excluded from live coverage.",
    },
  ],
  "/depeg/": [
    {
      href: "/stability-index/",
      label: "Stability Index",
      description: "Aggregate market regime across active peg stress.",
    },
    {
      href: "/timeline/",
      label: "Timeline",
      description: "Live wire of depegs, freezes, and grade changes.",
    },
    {
      href: "/liquidity/",
      label: "Liquidity",
      description: "Inspect DEX depth absorbing peg dislocations.",
    },
    {
      href: "/learn/case-studies/",
      label: "Case Studies",
      description: "Post-mortems of major historical depegs.",
    },
  ],
  "/stability-index/": [
    {
      href: "/depeg/",
      label: "Depeg & Recovery",
      description: "Active peg incidents and DEWS stress feeding PSI.",
    },
    {
      href: "/flows/",
      label: "Mint & Burn Flows",
      description: "Issuance and redemption pressure behind the trend leg.",
    },
    {
      href: "/liquidity/",
      label: "Liquidity",
      description: "Secondary market depth across tracked pools.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How PSI bands and components are computed.",
    },
  ],
  "/yield/": [
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "Inspect the safety grades backing every PYS rank.",
    },
    {
      href: "/portfolio/",
      label: "Portfolio",
      description: "Model weighted safety and exposure across holdings.",
    },
    {
      href: "/screener/",
      label: "Screener",
      description: "Combine yield filters with peg and backing criteria.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How Pharos Yield Score adjusts APY for risk.",
    },
  ],
  "/liquidity/": [
    {
      href: "/depeg/",
      label: "Depeg & Recovery",
      description: "Check where thin liquidity meets live peg stress.",
    },
    {
      href: "/flows/",
      label: "Mint & Burn Flows",
      description: "Compare secondary DEX depth against primary issuance.",
    },
    {
      href: "/chains/",
      label: "Chains",
      description: "Inspect stablecoin supply distribution by network.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "See how liquidity scores feed the Exit pillar.",
    },
  ],
  "/compliance/": [
    {
      href: "/freezewatch/",
      label: "FreezeWatch",
      description: "Compare regulatory status with issuer freeze controls.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "Review backing, exit, and control grades side by side.",
    },
    {
      href: "/alt-pegs/",
      label: "Non-USD Pegs",
      description: "Explore EUR, CHF, GBP, and regional stablecoins.",
    },
    {
      href: "/docs/",
      label: "Documentation",
      description: "Read compliance evidence rules and data contracts.",
    },
  ],
  "/dependency-map/": [
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "See how dependency caps affect coin grades.",
    },
    {
      href: "/portfolio/",
      label: "Portfolio",
      description: "Roll up shared upstream exposure across your book.",
    },
    {
      href: "/freezewatch/",
      label: "FreezeWatch",
      description: "Audit indirect freeze inheritance from upstream issuers.",
    },
    {
      href: "/compare/",
      label: "Compare",
      description: "Contrast wrapper and base-collateral pairs directly.",
    },
  ],
  "/alt-pegs/": [
    {
      href: "/compliance/",
      label: "Compliance",
      description: "Check MiCA and regional authorization by currency.",
    },
    {
      href: "/chains/",
      label: "Chains",
      description: "See where non-USD stablecoins hold live supply.",
    },
    {
      href: "/yield/",
      label: "Yield Intelligence",
      description: "Compare local-currency yields against regional rates.",
    },
    {
      href: "/screener/",
      label: "Screener",
      description: "Filter non-dollar stablecoins by safety and liquidity.",
    },
  ],
  "/compare/": [
    {
      href: "/screener/",
      label: "Screener",
      description: "Narrow the field before side-by-side comparison.",
    },
    {
      href: "/portfolio/",
      label: "Portfolio",
      description: "Combine shortlisted coins into one weighted book.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "Scan Backing, Exit, and Control grades across peers.",
    },
    {
      href: "/dependency-map/",
      label: "Dependency Map",
      description: "Check whether two candidates share upstream collateral.",
    },
  ],
  "/screener/": [
    {
      href: "/compare/",
      label: "Compare",
      description: "Open shortlisted stablecoins side by side.",
    },
    {
      href: "/portfolio/",
      label: "Portfolio",
      description: "Load filtered stablecoins into a portfolio stress test.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "Inspect full pillar scores and binding caps.",
    },
    {
      href: "/yield/",
      label: "Yield Intelligence",
      description: "Rank risk-adjusted stablecoin yields by PYS.",
    },
  ],
  "/learn/mechanisms/": [
    {
      href: "/learn/case-studies/",
      label: "Case Studies",
      description: "Retrospectives of how these designs behaved under stress.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How Pharos scores each mechanism's backing, exit, and control.",
    },
    {
      href: "/screener/",
      label: "Screener",
      description: "Filter tracked stablecoins by mechanism archetype and grade.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "Live Backing, Exit, and Control grades across the market.",
    },
  ],
  "/learn/case-studies/": [
    {
      href: "/cemetery/",
      label: "Cemetery",
      description: "Full register of defunct stablecoins and peak market caps.",
    },
    {
      href: "/depeg/",
      label: "Depeg & Recovery",
      description: "Live peg dislocations, DEWS alerts, and recovery windows.",
    },
    {
      href: "/learn/mechanisms/",
      label: "Mechanisms",
      description: "How each stablecoin architecture holds or loses its peg.",
    },
    {
      href: "/timeline/",
      label: "Timeline",
      description: "Chronological wire of depegs, freezes, and grade changes.",
    },
  ],
  "/methodology/": [
    {
      href: "/docs/",
      label: "Documentation",
      description: "Full technical methodology specs and plain Markdown twins.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "See the scoring formulas applied to every rated coin.",
    },
    {
      href: "/learn/mechanisms/",
      label: "Mechanisms",
      description: "Architecture explainers behind the scoring archetypes.",
    },
    {
      href: "/coverage/",
      label: "Coverage",
      description: "Check which signals and feeds are active coin by coin.",
    },
  ],
  "/docs/": [
    {
      href: "/methodology/",
      label: "Methodology",
      description: "Guided manual with Reader/Analyst mode and worked examples.",
    },
    {
      href: "/api/reference/",
      label: "API Reference",
      description: "HTTP endpoints, schemas, authentication, and OpenAPI spec.",
    },
    {
      href: "/coverage/",
      label: "Coverage",
      description: "Coin-by-coin matrix of live data availability.",
    },
    {
      href: "/status/",
      label: "Status",
      description: "Live health, freshness, and uptime of every Pharos pipeline.",
    },
  ],
  "/about/": [
    {
      href: "/coverage/",
      label: "Coverage",
      description: "Inspect every tracked capability coin by coin.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "Formulas, thresholds, and evidence standards in full.",
    },
    {
      href: "/funding/",
      label: "Funding",
      description: "Operating costs, public donations, and sustainability ledger.",
    },
    {
      href: "/status/",
      label: "Status",
      description: "Live operational health and 30-day pipeline history.",
    },
  ],
  "/blog/": [
    {
      href: "/changelog/",
      label: "Changelog",
      description: "Weekly release notes and methodology version bumps.",
    },
    {
      href: "/digest/",
      label: "Daily Digest",
      description: "Daily editorial recaps of market stress and capital moves.",
    },
    {
      href: "/about/",
      label: "About",
      description: "Project principles, sources, and editorial AI policy.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "Formulas and thresholds behind the product releases.",
    },
  ],
  "/changelog/": [
    {
      href: "/methodology/",
      label: "Methodology",
      description: "Versioned scoring, pricing, and depeg methodology histories.",
    },
    {
      href: "/blog/",
      label: "Blog",
      description: "Long-form product announcements and architectural deep dives.",
    },
    {
      href: "/status/",
      label: "Status",
      description: "Current pipeline health and 30-day incident log.",
    },
    {
      href: "/coverage/",
      label: "Coverage",
      description: "See newly tracked coins and feature availability live.",
    },
  ],
  "/status/": [
    {
      href: "/coverage/",
      label: "Coverage",
      description: "See which datasets and features are active per coin.",
    },
    {
      href: "/changelog/",
      label: "Changelog",
      description: "Weekly infrastructure and pipeline release notes.",
    },
    {
      href: "/api/",
      label: "API",
      description: "Endpoint access, freshness headers, and integration guide.",
    },
    {
      href: "/about/",
      label: "About",
      description: "Data pipeline architecture and upstream source disclosures.",
    },
  ],
};

/**
 * Curated cross-hub "See also" links (capped at 4 per route in SeeAlsoFooter).
 * Keeps risk, liquidity, and power-tool hubs mutually discoverable without
 * introducing self-links or duplicating the primary rail.
 */
export const SEE_ALSO_GRAPH: Readonly<Record<string, ReadonlyArray<SeeAlsoLink>>> = {
  ...CLIENT_ROUTE_SEE_ALSO_GRAPH,
  ...SERVER_ROUTE_SEE_ALSO_GRAPH,
};

export function getSeeAlsoLinks(pathname: string | null | undefined): ReadonlyArray<SeeAlsoLink> {
  const key = normalizeSeeAlsoPath(pathname);
  if (!key) return [];
  return SEE_ALSO_GRAPH[key] ?? [];
}
