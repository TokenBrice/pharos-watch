import type { SeeAlsoLink } from "@/components/see-also-footer";

/**
 * Curated cross-hub "See also" links (capped at 4 per route in SeeAlsoFooter).
 * Keeps risk, liquidity, and power-tool hubs mutually discoverable without
 * introducing self-links or duplicating the primary rail.
 */
export const SEE_ALSO_GRAPH: Readonly<Record<string, ReadonlyArray<SeeAlsoLink>>> = {
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
  "/safety-scores/": [
    {
      href: "/dependency-map/",
      label: "Dependency Map",
      description: "Trace upstream collateral and wrapper exposure.",
    },
    {
      href: "/compare/",
      label: "Compare",
      description: "Put safety grades and pillars side by side.",
    },
    {
      href: "/screener/",
      label: "Screener",
      description: "Filter the full set by grade, DEWS, and backing.",
    },
    {
      href: "/methodology/",
      label: "Methodology",
      description: "Backing, Exit, and Control scoring formulas.",
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
  "/freezewatch/": [
    {
      href: "/compliance/",
      label: "Compliance",
      description: "MiCA and GENIUS authorization posture by issuer.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "See how control posture feeds overall grades.",
    },
    {
      href: "/dependency-map/",
      label: "Dependency Map",
      description: "Spot upstream freezable collateral inheritance.",
    },
    {
      href: "/timeline/",
      label: "Timeline",
      description: "Chronological feed of freeze and enforcement events.",
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
  "/flows/": [
    {
      href: "/liquidity/",
      label: "Liquidity",
      description: "Pair primary mint/burn flows with DEX depth.",
    },
    {
      href: "/chains/",
      label: "Chains",
      description: "Track net stablecoin growth across networks.",
    },
    {
      href: "/stability-index/",
      label: "Stability Index",
      description: "Follow how supply trend shifts market regime.",
    },
    {
      href: "/timeline/",
      label: "Timeline",
      description: "Watch market events alongside capital rotations.",
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
  "/chains/": [
    {
      href: "/liquidity/",
      label: "Liquidity",
      description: "Measure DEX depth backing on-chain supply.",
    },
    {
      href: "/flows/",
      label: "Mint & Burn Flows",
      description: "Follow issuance and redemption activity per chain.",
    },
    {
      href: "/alt-pegs/",
      label: "Non-USD Pegs",
      description: "See non-dollar stablecoin footprint across chains.",
    },
    {
      href: "/screener/",
      label: "Screener",
      description: "Filter tracked stablecoins by chain and risk metrics.",
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
  "/portfolio/": [
    {
      href: "/dependency-map/",
      label: "Dependency Map",
      description: "Visualize shared collateral chains across holdings.",
    },
    {
      href: "/compare/",
      label: "Compare",
      description: "Evaluate substitutes for concentrated positions.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "Inspect pillar ratings across the full market.",
    },
    {
      href: "/pharoswatchbot/",
      label: "Alert Bot",
      description: "Follow your book in Telegram for live risk alerts.",
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
};

function normalizeSeeAlsoPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  if (pathname === "/") return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "/";
}

export function getSeeAlsoLinks(pathname: string | null | undefined): ReadonlyArray<SeeAlsoLink> {
  const key = normalizeSeeAlsoPath(pathname);
  if (!key) return [];
  return SEE_ALSO_GRAPH[key] ?? [];
}
