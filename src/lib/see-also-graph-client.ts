import type { SeeAlsoLink } from "@/components/see-also-footer-view";

/**
 * Subset of `SEE_ALSO_GRAPH` rendered by `RouteSeeAlsoFooter` in the global
 * footer. Routes that render `<SeeAlsoFooter>` directly in their Server
 * Component (`createClientFeaturePage` routes and Learn/Pharos hubs) live in
 * `src/lib/see-also-graph.ts` so they never enter the root layout client chunk.
 */
export const CLIENT_ROUTE_SEE_ALSO_GRAPH: Readonly<Record<string, ReadonlyArray<SeeAlsoLink>>> = {
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
  "/cemetery/": [
    {
      href: "/learn/case-studies/",
      label: "Case Studies",
      description: "Deep post-mortems of major stablecoin collapses.",
    },
    {
      href: "/depeg/",
      label: "Depeg & Recovery",
      description: "Live peg stress and active incident tracking.",
    },
    {
      href: "/timeline/",
      label: "Timeline",
      description: "Chronological wire of depegs, freezes, and grade changes.",
    },
    {
      href: "/learn/mechanisms/",
      label: "Mechanisms",
      description: "How each peg architecture holds up or breaks under stress.",
    },
  ],
  "/timeline/": [
    {
      href: "/depeg/",
      label: "Depeg & Recovery",
      description: "Active peg incidents, DEWS stress, and recovery windows.",
    },
    {
      href: "/freezewatch/",
      label: "FreezeWatch",
      description: "Issuer freeze powers and enforcement history.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "Backing, Exit, and Control grades across tracked coins.",
    },
    {
      href: "/digest/",
      label: "Daily Digest",
      description: "Daily editorial recap of notable market events.",
    },
  ],
  "/upcoming/": [
    {
      href: "/coverage/",
      label: "Coverage",
      description: "See what Pharos tracks once a stablecoin goes live.",
    },
    {
      href: "/stablecoins/",
      label: "Stablecoins",
      description: "Browse every active tracked stablecoin by peg and backing.",
    },
    {
      href: "/compliance/",
      label: "Compliance",
      description: "Review MiCA and GENIUS authorization posture by issuer.",
    },
    {
      href: "/safety-scores/",
      label: "Safety Scores",
      description: "Inspect how launched coins are rated across three pillars.",
    },
  ],
  "/pharoswatchbot/": [
    {
      href: "/depeg/",
      label: "Depeg & Recovery",
      description: "Monitor live peg incidents and DEWS stress signals.",
    },
    {
      href: "/freezewatch/",
      label: "FreezeWatch",
      description: "Track issuer blacklist controls and freeze actions.",
    },
    {
      href: "/portfolio/",
      label: "Portfolio",
      description: "Build a custom book and monitor its combined risk.",
    },
    {
      href: "/coverage/",
      label: "Coverage",
      description: "Check which alerts and signals are tracked coin by coin.",
    },
  ],
};

export function normalizeSeeAlsoPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  if (pathname === "/") return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "/";
}

export function getClientRouteSeeAlsoLinks(pathname: string | null | undefined): ReadonlyArray<SeeAlsoLink> {
  const key = normalizeSeeAlsoPath(pathname);
  if (!key) return [];
  return CLIENT_ROUTE_SEE_ALSO_GRAPH[key] ?? [];
}
