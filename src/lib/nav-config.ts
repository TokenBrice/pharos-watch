import type { LucideIcon } from "lucide-react";
import {
  Activity,
  CircleDollarSign,
  LayoutDashboard,
  Waves,
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
  Heart,
  TableProperties,
  createLucideIcon,
} from "lucide-react";
import { isRouteActive } from "@/lib/navigation";

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
   * Presentation-only short form for the desktop quick rail from 1440px to
   * 1679px and the mobile bottom bar. Never the label a search/index consumer
   * should show — `NAV_ITEMS` is ordered so canonical entries win the dedupe.
   */
  shortLabel?: string;
  /**
   * Presentation-only narrowest form for the desktop quick rail below 1440px
   * (falls back to `shortLabel`). Same indexing caveat as `shortLabel`.
   */
  compactLabel?: string;
  icon: LucideIcon;
  description?: string;
  /**
   * Extra search terms for the command palette: acronyms, synonyms, and the
   * words people actually type. Space-separated, lowercase. Never rendered.
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
  /** Flat membership: mobile drawer and command palette. */
  items: readonly NavItem[];
  /** Desktop panel layout. When present, `items` is exactly its flattening. */
  columns?: readonly NavColumn[];
}

/* ── Canonical items shared by the quick rail and the grouped menus ─────── */

const DASHBOARD_NAV_ITEM: NavItem = {
  href: "/",
  label: "Home",
  icon: LayoutDashboard,
  description: "Market stress, rankings, and triage",
  keywords: "home dashboard overview market stress rankings",
};

const STABILITY_INDEX_NAV_ITEM: NavItem = {
  href: "/stability-index/",
  label: "Stability Index",
  icon: LighthouseIcon,
  description: "Market-regime read for stablecoins",
  // "PSI" is the in-product acronym; people also ask for the market "mood".
  keywords: "psi stability regime mood sentiment market health",
};

const SAFETY_SCORES_NAV_ITEM: NavItem = {
  href: "/safety-scores/",
  label: "Safety Scores",
  icon: ShieldCheck,
  description: "Safety grades and upstream risk",
  keywords: "safety score grade rating risk report card bluechip",
};

const YIELD_NAV_ITEM: NavItem = {
  href: "/yield/",
  label: "Yield Intelligence",
  icon: CircleDollarSign,
  description: "Yield ranked after adjusting for risk",
  keywords: "yield apy apr rates savings earn pys",
};

const FREEZEWATCH_NAV_ITEM: NavItem = {
  href: "/freezewatch/",
  label: "FreezeWatch",
  icon: FreezeShieldIcon,
  description: "Issuer power to freeze your balance",
  keywords: "freeze blacklist seize censorship issuer control frozen",
};

const DEPEG_NAV_ITEM: NavItem = {
  href: "/depeg/",
  label: "Depeg & Recovery",
  icon: Activity,
  description: "Live peg incidents and recovery outlooks",
  // The visible description is deliberately short; these are the acronyms
  // people type in the palette (DDR = Depeg Duration Resolver, DEWS = Depeg
  // Early Warning System) and this route is where both live.
  keywords: "depeg ddr dews duration resolver early warning peg incident recovery",
};

/**
 * Desktop quick rail: the six highest-traffic routes, promoted out of the
 * dropdowns so they cost one click instead of hover-then-scan. Apart from
 * Home, the rail is their sole desktop navigation surface. Labels step down
 * in three tiers to fit the masthead (measured 2026-10-11): `compactLabel`
 * below 1440px, `shortLabel` from 1440px, the canonical `label` from 1680px.
 */
export const QUICK_NAV_ITEMS: readonly NavItem[] = [
  DASHBOARD_NAV_ITEM,
  { ...SAFETY_SCORES_NAV_ITEM, shortLabel: "Safety" },
  // "Yield" reads unambiguously at every width and keeps the rail inside the
  // masthead width budget; search still indexes the canonical group label.
  { ...YIELD_NAV_ITEM, label: "Yield", shortLabel: "Yield" },
  // Compact labels keep the rail and section menus within the masthead.
  { ...DEPEG_NAV_ITEM, shortLabel: "Depeg" },
  // "Stability" is a real word and wins wherever it fits; below 1440px the
  // six-item rail only fits the in-product acronym. The palette keeps `psi`.
  { ...STABILITY_INDEX_NAV_ITEM, shortLabel: "Stability", compactLabel: "PSI" },
  { ...FREEZEWATCH_NAV_ITEM, shortLabel: "FreezeWatch", compactLabel: "Freeze" },
];

/* ── Resources columns — reference, updates, and product links ─────── */

const MORE_COLUMNS: readonly NavColumn[] = [
  {
    key: "research",
    label: "Research",
    items: [
      { href: "/blog/", label: "Blog", icon: BookOpen, description: "Product updates and the Pharos story", keywords: "blog posts articles announcements" },
      { href: "/learn/mechanisms/", label: "Mechanisms", icon: Lightbulb, description: "How each design holds its peg", keywords: "mechanism archetype design how it works collateral algorithmic" },
      { href: "/learn/case-studies/", label: "Case Studies", icon: BookMarked, description: "Retrospectives of major depegs", keywords: "case study retrospective post-mortem history terra ust svb" },
    ],
  },
  {
    key: "watch",
    label: "Updates",
    items: [
      { href: "/digest/", label: "Daily Digest", icon: Newspaper, description: "Daily recap of the stablecoin market", keywords: "digest daily news recap newsletter today" },
      { href: "/timeline/", label: "Timeline", icon: ScrollText, description: "Every depeg, freeze, and grade change", keywords: "timeline tape events history feed" },
      { href: "/changelog/", label: "Changelog", icon: PenLine, description: "Weekly release notes and updates", keywords: "changelog release notes what's new updates" },
    ],
  },
  {
    key: "methods",
    label: "Transparency",
    items: [
      { href: "/methodology/", label: "Methodology", icon: BookOpen, description: "Formulas, thresholds, and versions", keywords: "methodology formula threshold how computed calculated version glossary definitions terms" },
      { href: "/coverage/", label: "Coverage", icon: TableProperties, description: "What Pharos tracks, coin by coin", keywords: "coverage tracked supported data availability" },
      { href: "/status/", label: "Status", icon: MonitorCheck, description: "Live health of every data pipeline", keywords: "status health uptime pipeline outage" },
    ],
  },
  {
    key: "pharos",
    label: "About Pharos",
    items: [
      { href: "/about/", label: "About", icon: Info, description: "Scope, sources, and why Pharos exists", keywords: "about team independent sources mission" },
      { href: "/funding/", label: "Funding", icon: Heart, description: "Costs, donations, and sustainability", keywords: "funding donate support costs sponsor" },
      {
        href: "https://pharosville.pharos.watch/",
        label: "PharosVille",
        icon: Ship,
        description: "The stablecoin universe as a harbor",
        keywords: "pharosville harbor game visualization",
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
      { href: "/liquidity/", label: "Liquidity", icon: Waves, description: "DEX depth, durability, and peg support", keywords: "liquidity dex depth pool slippage" },
      { href: "/flows/", label: "Flows", icon: ArrowUpDown, description: "Mint and burn pressure by chain", keywords: "flows mint burn issuance redemption supply change" },
      { href: "/chains/", label: "Chains", icon: Layers, description: "Stablecoin share and health by chain", keywords: "chains network ethereum solana tron l2 by chain" },
      { href: "/alt-pegs/", label: "Non-USD Pegs", icon: Globe, description: "Market structure beyond the dollar", keywords: "non-usd euro eur gbp chf jpy brl gold alt pegs currency" },
      { href: "/upcoming/", label: "Upcoming", icon: Rocket, description: "Pre-launch stablecoins and launch dates", keywords: "upcoming launch pre-launch calendar new coins pipeline" },
    ],
  },
  {
    key: "risk",
    label: "Risk",
    items: [
      { href: "/compliance/", label: "Compliance", icon: Landmark, description: "MiCA and GENIUS status, coin by coin", keywords: "compliance mica genius regulation regulated license authorized" },
      { href: "/dependency-map/", label: "Dependency Map", icon: Network, description: "Collateral and wrapper dependency graph", keywords: "dependency map contagion collateral wrapper graph exposure" },
      { href: "/cemetery/", label: "Cemetery", icon: Skull, description: "Failed stablecoins and their lessons", keywords: "cemetery dead failed collapsed defunct graveyard" },
    ],
  },
  {
    key: "tools",
    label: "Tools",
    items: [
      { href: "/screener/", label: "Screener", icon: SlidersHorizontal, description: "Filter every stablecoin on any axis", keywords: "screener filter find search criteria" },
      { href: "/compare/", label: "Compare", icon: ArrowLeftRight, description: "Peer sets and substitutes side by side", keywords: "compare vs versus side by side alternative" },
      { href: "/portfolio/", label: "Portfolio", icon: Wallet, description: "Your holdings as one stablecoin book", keywords: "portfolio holdings my coins wallet exposure" },
      { href: "/pharoswatchbot/", label: "Alert Bot", icon: Send, description: "Telegram alerts for depegs and launches", keywords: "alert bot telegram notifications subscribe watch" },
      { href: "/api/", label: "API", icon: KeyRound, description: "Access keys, free grades, and the API reference", keywords: "api key developer access endpoint docs reference integration" },
    ],
  },
  {
    key: "more",
    label: "Resources",
    columns: MORE_COLUMNS,
    items: MORE_COLUMNS.flatMap((column) => column.items),
  },
];

function normalizeNavPath(pathname: string): string {
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
 * Active-state test shared by every chrome surface. A destination is active on
 * its own route and on any route beneath it. The dashboard only matches exactly.
 */
export function isNavItemActive(pathname: string | null | undefined, item: NavItem): boolean {
  const path = pathname ?? "/";
  if (item.external) return false;
  return isRouteActive(path, item.href);
}

/**
 * Flat list for the command palette, 404 route-guess, and homepage shortcuts.
 * Canonical rail items are seeded first so they win the dedupe against their
 * presentation-only quick-rail aliases ("Yield Intelligence", not "Yield") and
 * so index consumers that preserve insertion order surface primary routes
 * ahead of the long tail.
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
    FREEZEWATCH_NAV_ITEM,
  ];
  for (const item of [
    ...canonicalRailItems,
    ...NAV_GROUPS.flatMap((group) => group.items),
    ...QUICK_NAV_ITEMS,
  ]) {
    const key = normalizeNavPath(item.href);
    if (seen.has(key)) continue;
    seen.add(key);
    flat.push(item);
  }
  return flat;
})();
