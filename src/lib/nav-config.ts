import type { LucideIcon } from "lucide-react";
import {
  Activity,
  CircleDollarSign,
  LayoutDashboard,
  Waves,
  Compass,
  Skull,
  Info,
  Layers,
  BookOpen,
  KeyRound,
  Lightbulb,
  ShieldCheck,
  ArrowLeftRight,
  ArrowUpDown,
  Newspaper,
  PenLine,
  Rocket,
  Send,
  Wallet,
  Network,
  SlidersHorizontal,
  ScrollText,
  Globe,
  Ship,
  Landmark,
  MonitorCheck,
  BookMarked,
  BookA,
  Coins,
  createLucideIcon,
} from "lucide-react";

const LighthouseIcon = createLucideIcon("lighthouse", [
  ["path", { d: "M10 22V8l2-6 2 6v14", key: "tower" }],
  ["path", { d: "M7 22h10", key: "base" }],
  ["path", { d: "M9 12h6", key: "band1" }],
  ["path", { d: "M9 16h6", key: "band2" }],
  ["circle", { cx: "12", cy: "5", r: "1.5", key: "light" }],
  ["path", { d: "M6 4l3.5 1M18 4l-3.5 1", key: "beams" }],
]);

const FreezeShieldIcon = createLucideIcon("freeze-shield", [
  ["path", { d: "M12 2 L20 7 L20 17 L12 22 L4 17 L4 7 Z", key: "shield" }],
  ["path", { d: "M12 8 L12 16", key: "snowflake-v" }],
  ["path", { d: "M8.5 10 L15.5 14", key: "snowflake-d1" }],
  ["path", { d: "M8.5 14 L15.5 10", key: "snowflake-d2" }],
]);

export interface NavItem {
  href: string;
  label: string;
  /**
   * Presentation-only short form for the desktop quick rail below `xl`.
   * Never the label a search/index consumer should show — `NAV_ITEMS` is
   * ordered so canonical group entries win the dedupe.
   */
  shortLabel?: string;
  icon: LucideIcon;
  description?: string;
  external?: boolean;
}

/** Labeled column inside a multi-section menu panel (currently only `more`). */
export interface NavColumn {
  key: string;
  label: string;
  items: readonly NavItem[];
}

export interface NavGroup {
  key: string;
  label: string;
  /** Flat membership: mobile drawer, command palette, `/sitemap-tree/`. */
  items: readonly NavItem[];
  /** Desktop panel layout. When present, `items` is exactly its flattening. */
  columns?: readonly NavColumn[];
}

/* ── Canonical items shared by the quick rail and the grouped menus ─────── */

const DASHBOARD_NAV_ITEM: NavItem = {
  href: "/",
  label: "Dashboard",
  icon: LayoutDashboard,
  description: "Live triage surface for market stress, rankings, and first-pass research",
};

const STABILITY_INDEX_NAV_ITEM: NavItem = {
  href: "/stability-index/",
  label: "Stability Index",
  icon: LighthouseIcon,
  description: "Market-regime read for the stablecoin system",
};

const SAFETY_SCORES_NAV_ITEM: NavItem = {
  href: "/safety-scores/",
  label: "Safety Scores",
  icon: ShieldCheck,
  description: "Cross-market safety grades and contagion scenarios",
};

const YIELD_NAV_ITEM: NavItem = {
  href: "/yield/",
  label: "Yield Intelligence",
  icon: CircleDollarSign,
  description: "Yield ranked after adjusting for stablecoin risk",
};

const DEPEG_NAV_ITEM: NavItem = {
  href: "/depeg/",
  label: "Depeg & Recovery",
  icon: Activity,
  description: "Live peg incidents, DEWS early warnings, DDR recovery outlooks, and reviews",
};

/**
 * Desktop quick rail: the five highest-traffic routes, promoted out of the
 * dropdowns so they cost one click instead of hover-then-scan. They stay
 * listed inside their owning menu as well — the rail is a shortcut layer, not
 * a sibling section, so "I opened Risk and Safety Scores wasn't there" can't
 * happen.
 */
export const QUICK_NAV_ITEMS: readonly NavItem[] = [
  DASHBOARD_NAV_ITEM,
  { ...SAFETY_SCORES_NAV_ITEM, shortLabel: "Safety" },
  // "Yield" reads unambiguously at every width and keeps the rail inside the
  // masthead width budget; search still indexes the canonical group label.
  { ...YIELD_NAV_ITEM, label: "Yield", shortLabel: "Yield" },
  // Below xl the rail falls back to the in-product shorthand (DDR, PSI); the
  // five-item rail plus the section menus does not fit 1024px otherwise.
  { ...DEPEG_NAV_ITEM, shortLabel: "DDR" },
  { ...STABILITY_INDEX_NAV_ITEM, shortLabel: "PSI" },
];

/* ── "More" columns — the low-traffic tail, organized instead of dumped ─── */

const MORE_COLUMNS: readonly NavColumn[] = [
  {
    key: "learn",
    label: "Learn",
    items: [
      { href: "/learn/", label: "Learn", icon: BookOpen, description: "Stablecoin mechanisms, case studies, and glossary definitions" },
      { href: "/learn/mechanisms/", label: "Mechanisms", icon: Lightbulb, description: "How each stablecoin design produces its peg" },
      { href: "/learn/case-studies/", label: "Case Studies", icon: BookMarked, description: "Long-form retrospectives of major depegs and failures" },
      { href: "/learn/glossary/", label: "Glossary", icon: BookA, description: "The Pharos vocabulary, defined and version-pinned" },
    ],
  },
  {
    key: "updates",
    label: "Updates",
    items: [
      { href: "/digest/", label: "Daily Digest", icon: Newspaper, description: "Daily editorial recap of the stablecoin market" },
      { href: "/timeline/", label: "Timeline", icon: ScrollText, description: "Unified chronological event feed across depeg, freeze, and grade transitions" },
      { href: "/changelog/", label: "Changelog", icon: PenLine, description: "Weekly release notes and feature updates" },
      { href: "/blog/", label: "Blog", icon: BookOpen, description: "Product updates and the story of Pharos" },
      { href: "/pharoswatchbot/", label: "Alert Bot", icon: Send, description: "PharosWatchBot push alerts for depegs, DEWS shifts, launches, and the daily digest" },
    ],
  },
  {
    key: "pharos",
    label: "Pharos",
    items: [
      { href: "/methodology/", label: "Methodology", icon: BookOpen, description: "Reference manual for formulas, thresholds, and changelogs" },
      { href: "/about/", label: "About", icon: Info, description: "Scope, data sources, and why Pharos exists" },
      { href: "/api/", label: "API Access", icon: KeyRound, description: "Request a public API key and open the endpoint reference" },
      { href: "/status/", label: "System Status", icon: MonitorCheck, description: "Live health of every data pipeline and cron sync" },
      {
        href: "https://pharosville.pharos.watch/",
        label: "PharosVille",
        icon: Ship,
        description: "The stablecoin universe as a working harbor — DEWS zones at a glance",
        external: true,
      },
    ],
  },
];

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: "markets",
    label: "Markets",
    items: [
      STABILITY_INDEX_NAV_ITEM,
      YIELD_NAV_ITEM,
      { href: "/liquidity/", label: "Liquidity", icon: Waves, description: "DEX depth, durability, and market support" },
      { href: "/flows/", label: "Flows", icon: ArrowUpDown, description: "Configured issuance-chain mint and burn pressure" },
      { href: "/chains/", label: "Chains", icon: Layers, description: "Chain-by-chain stablecoin share, mix, and health" },
      { href: "/alt-pegs/", label: "Non-USD Pegs", icon: Globe, description: "Market structure and cohort growth beyond dollar pegs" },
      { href: "/upcoming/", label: "Upcoming", icon: Rocket, description: "Pre-launch stablecoins and launch-watch context" },
    ],
  },
  {
    key: "risk",
    label: "Risk",
    items: [
      SAFETY_SCORES_NAV_ITEM,
      DEPEG_NAV_ITEM,
      { href: "/freezewatch/", label: "FreezeWatch", icon: FreezeShieldIcon, description: "Issuer control over your stablecoin balance, surfaced live" },
      { href: "/compliance/", label: "Compliance", icon: Landmark, description: "MiCA authorization and GENIUS implementation status across tracked stablecoins" },
      { href: "/dependency-map/", label: "Dependency Map", icon: Network, description: "Collateral graph for hidden upstream stablecoin risk" },
      { href: "/cemetery/", label: "Cemetery", icon: Skull, description: "Failed stablecoins and the lessons they left behind" },
    ],
  },
  {
    key: "tools",
    label: "Tools",
    items: [
      { href: "/screener/", label: "Screener", icon: SlidersHorizontal, description: "Multi-axis filter across every tracked stablecoin" },
      { href: "/compare/", label: "Compare", icon: ArrowLeftRight, description: "Build a live peer set and judge substitutes side by side" },
      { href: "/portfolio/", label: "Portfolio", icon: Wallet, description: "Look through your holdings as one combined stablecoin book" },
      { href: "/stablecoins/", label: "Stablecoin Directory", icon: Coins, description: "Every tracked stablecoin, browsable by peg, backing, governance, and infrastructure" },
    ],
  },
  {
    key: "more",
    label: "More",
    columns: MORE_COLUMNS,
    items: MORE_COLUMNS.flatMap((column) => column.items),
  },
];

export function normalizeNavPath(pathname: string): string {
  if (pathname === "/") return "/";
  return pathname.replace(/\/+$/, "");
}

/**
 * Sticky top offset for the global chrome headers. Interior routes nudge down
 * 3px to clear the persistent PSI strip's seam; the homepage has no strip above
 * the chrome, so it pins flush. Shared so the desktop top-nav and the mobile
 * header stay in lockstep. Returns a static Tailwind class for the JIT scanner.
 */
export function stickyChromeTopOffsetClass(pathname: string | null | undefined): string {
  return pathname === "/" ? "top-0" : "top-[3px]";
}

/**
 * Mobile drawer defaults. Every group starts collapsed now that the quick rail
 * carries the highest-traffic routes above them: the drawer opens as four
 * labeled headers instead of eleven pre-expanded rows. `useNavCollapse` still
 * force-expands whichever group owns the active route.
 */
export const DEFAULT_EXPANDED: Record<string, boolean> = {
  markets: false,
  risk: false,
  tools: false,
  more: false,
};

/** Bottom items (always shown at sidebar bottom) */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  { href: "/start/", label: "Start Here", icon: Compass, description: "Shortest route into the product for new or returning users" },
];

/**
 * Flat list for the command palette, 404 route-guess, and homepage shortcuts.
 * Group items come first so the rail's presentation-only `shortLabel` aliases
 * never win the dedupe: search must offer "Yield Intelligence", not "Yield".
 */
export const NAV_ITEMS: NavItem[] = (() => {
  const seen = new Set<string>();
  const flat: NavItem[] = [];
  for (const item of [...NAV_GROUPS.flatMap((group) => group.items), ...QUICK_NAV_ITEMS, ...BOTTOM_NAV_ITEMS]) {
    const key = normalizeNavPath(item.href);
    if (seen.has(key)) continue;
    seen.add(key);
    flat.push(item);
  }
  return flat;
})();
