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
  /**
   * Extra search terms for the command palette. Lets a route stay findable by
   * the acronyms people actually type without forcing them into the visible
   * label or description.
   */
  keywords?: string;
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
  description: "Market stress, rankings, and triage",
};

const STABILITY_INDEX_NAV_ITEM: NavItem = {
  href: "/stability-index/",
  label: "Stability Index",
  icon: LighthouseIcon,
  description: "Market-regime read for stablecoins",
};

const SAFETY_SCORES_NAV_ITEM: NavItem = {
  href: "/safety-scores/",
  label: "Safety Scores",
  icon: ShieldCheck,
  description: "Safety grades and contagion scenarios",
};

const YIELD_NAV_ITEM: NavItem = {
  href: "/yield/",
  label: "Yield Intelligence",
  icon: CircleDollarSign,
  description: "Yield ranked after adjusting for risk",
};

const DEPEG_NAV_ITEM: NavItem = {
  href: "/depeg/",
  label: "Depeg & Recovery",
  icon: Activity,
  description: "Live peg incidents and recovery outlooks",
  // The visible description is deliberately short; these are the acronyms
  // people type in the palette (DDR = Depeg Duration Resolver, DEWS = Depeg
  // Early Warning System) and this route is where both live.
  keywords: "ddr dews depeg duration resolver early warning",
};

/**
 * Desktop quick rail: the five highest-traffic routes, promoted out of the
 * dropdowns so they cost one click instead of hover-then-scan. Apart from the
 * dashboard, the rail is their sole desktop navigation surface.
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

/* ── Resources columns — reference, monitoring, and product links ───── */

const MORE_COLUMNS: readonly NavColumn[] = [
  {
    key: "research",
    label: "Research",
    items: [
      { href: "/learn/", label: "Learn", icon: BookOpen, description: "Mechanisms, case studies, and glossary" },
      { href: "/learn/mechanisms/", label: "Mechanisms", icon: Lightbulb, description: "How each design holds its peg" },
      { href: "/learn/case-studies/", label: "Case Studies", icon: BookMarked, description: "Retrospectives of major depegs" },
      { href: "/learn/glossary/", label: "Glossary", icon: BookA, description: "The Pharos vocabulary, defined" },
      { href: "/methodology/", label: "Methodology", icon: BookOpen, description: "Formulas, thresholds, and versions" },
    ],
  },
  {
    key: "watch",
    label: "Watch",
    items: [
      { href: "/digest/", label: "Daily Digest", icon: Newspaper, description: "Daily recap of the stablecoin market" },
      { href: "/timeline/", label: "Timeline", icon: ScrollText, description: "Every depeg, freeze, and grade change" },
      { href: "/pharoswatchbot/", label: "Alert Bot", icon: Send, description: "Telegram alerts for depegs and launches" },
    ],
  },
  {
    key: "pharos",
    label: "Pharos",
    items: [
      { href: "/about/", label: "About", icon: Info, description: "Scope, sources, and why Pharos exists" },
      { href: "/changelog/", label: "Changelog", icon: PenLine, description: "Weekly release notes and updates" },
      { href: "/blog/", label: "Blog", icon: BookOpen, description: "Product updates and the Pharos story" },
      { href: "/api/", label: "API Access", icon: KeyRound, description: "Public API keys and endpoint reference" },
      { href: "/status/", label: "System Status", icon: MonitorCheck, description: "Live health of every data pipeline" },
      {
        href: "https://pharosville.pharos.watch/",
        label: "PharosVille",
        icon: Ship,
        description: "The stablecoin universe as a harbor",
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
      { href: "/liquidity/", label: "Liquidity", icon: Waves, description: "DEX depth, durability, and peg support" },
      { href: "/flows/", label: "Flows", icon: ArrowUpDown, description: "Mint and burn pressure by chain" },
      { href: "/chains/", label: "Chains", icon: Layers, description: "Stablecoin share and health by chain" },
      { href: "/alt-pegs/", label: "Non-USD Pegs", icon: Globe, description: "Market structure beyond the dollar" },
      { href: "/upcoming/", label: "Upcoming", icon: Rocket, description: "Pre-launch stablecoins and launch dates" },
    ],
  },
  {
    key: "risk",
    label: "Risk",
    items: [
      { href: "/freezewatch/", label: "FreezeWatch", icon: FreezeShieldIcon, description: "Issuer power to freeze your balance" },
      { href: "/compliance/", label: "Compliance", icon: Landmark, description: "MiCA and GENIUS status, coin by coin" },
      { href: "/dependency-map/", label: "Dependency Map", icon: Network, description: "Collateral graph of upstream risk" },
      { href: "/cemetery/", label: "Cemetery", icon: Skull, description: "Failed stablecoins and their lessons" },
    ],
  },
  {
    key: "tools",
    label: "Tools",
    items: [
      { href: "/screener/", label: "Screener", icon: SlidersHorizontal, description: "Filter every stablecoin on any axis" },
      { href: "/compare/", label: "Compare", icon: ArrowLeftRight, description: "Peer sets and substitutes side by side" },
      { href: "/portfolio/", label: "Portfolio", icon: Wallet, description: "Your holdings as one stablecoin book" },
      { href: "/stablecoins/", label: "Stablecoin Directory", icon: Coins, description: "Browse every tracked stablecoin" },
    ],
  },
  {
    key: "more",
    label: "Resources",
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

/** Bottom items (always shown at sidebar bottom) */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  { href: "/start/", label: "Start Here", icon: Compass, description: "The fastest way into Pharos" },
];

/**
 * Flat list for the command palette, 404 route-guess, and homepage shortcuts.
 * Canonical rail items are seeded before their presentation-only quick-rail
 * aliases so search offers "Yield Intelligence", not "Yield".
 */
export const NAV_ITEMS: NavItem[] = (() => {
  const seen = new Set<string>();
  const flat: NavItem[] = [];
  const canonicalRailItems = [
    DASHBOARD_NAV_ITEM,
    SAFETY_SCORES_NAV_ITEM,
    YIELD_NAV_ITEM,
    DEPEG_NAV_ITEM,
    STABILITY_INDEX_NAV_ITEM,
  ];
  for (const item of [
    ...NAV_GROUPS.flatMap((group) => group.items),
    ...canonicalRailItems,
    ...QUICK_NAV_ITEMS,
    ...BOTTOM_NAV_ITEMS,
  ]) {
    const key = normalizeNavPath(item.href);
    if (seen.has(key)) continue;
    seen.add(key);
    flat.push(item);
  }
  return flat;
})();
