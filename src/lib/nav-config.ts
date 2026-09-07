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
   * Presentation-only short form for the desktop quick rail below `2xl` and
   * the mobile bottom bar. Never the label a search/index consumer should
   * show — `NAV_ITEMS` is ordered so canonical entries win the dedupe.
   */
  shortLabel?: string;
  icon: LucideIcon;
  description?: string;
  /**
   * Extra search terms for the command palette: acronyms, synonyms, and the
   * words people actually type. Space-separated, lowercase. Never rendered.
   */
  keywords?: string;
  /**
   * Additional path prefixes that count as "inside" this destination for
   * active-state purposes, on top of `href` itself. Lets `/stablecoin/<id>/`
   * light up the directory entry even though the two routes share no prefix.
   */
  activePrefixes?: readonly string[];
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
  keywords: "home overview market stress rankings",
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
  description: "Safety grades and contagion scenarios",
  keywords: "safety score grade rating risk report card bluechip contagion",
};

const YIELD_NAV_ITEM: NavItem = {
  href: "/yield/",
  label: "Yield Intelligence",
  icon: CircleDollarSign,
  description: "Yield ranked after adjusting for risk",
  keywords: "yield apy apr rates savings earn pys",
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

export const START_HERE_NAV_ITEM: NavItem = {
  href: "/start/",
  label: "Start Here",
  icon: Compass,
  description: "The fastest way into Pharos",
  keywords: "start here onboarding guide new beginner intro help",
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
  // Compact labels keep the rail and section menus within the masthead.
  { ...DEPEG_NAV_ITEM, shortLabel: "Depeg" },
  // "Stability" is a real word; "PSI" was the only acronym-only top-level
  // label and newcomers had no way to decode it. The palette keeps `psi`.
  { ...STABILITY_INDEX_NAV_ITEM, shortLabel: "Stability" },
];

/* ── Resources columns — reference, updates, and product links ─────── */

const MORE_COLUMNS: readonly NavColumn[] = [
  {
    key: "research",
    label: "Research",
    items: [
      { href: "/learn/", label: "Learn", icon: BookOpen, description: "Mechanisms, case studies, and glossary", keywords: "learn education explainers" },
      { href: "/learn/mechanisms/", label: "Mechanisms", icon: Lightbulb, description: "How each design holds its peg", keywords: "mechanism archetype design how it works collateral algorithmic" },
      { href: "/learn/case-studies/", label: "Case Studies", icon: BookMarked, description: "Retrospectives of major depegs", keywords: "case study retrospective post-mortem history terra ust svb" },
      { href: "/learn/glossary/", label: "Glossary", icon: BookA, description: "The Pharos vocabulary, defined", keywords: "glossary terms definitions vocabulary dictionary" },
      { href: "/methodology/", label: "Methodology", icon: BookOpen, description: "Formulas, thresholds, and versions", keywords: "methodology formula threshold how computed calculated version" },
      { href: "/coverage/", label: "Coverage", icon: TableProperties, description: "What Pharos tracks, coin by coin", keywords: "coverage tracked supported data availability" },
    ],
  },
  {
    key: "watch",
    label: "Updates & Alerts",
    items: [
      { href: "/digest/", label: "Daily Digest", icon: Newspaper, description: "Daily recap of the stablecoin market", keywords: "digest daily news recap newsletter today" },
      { href: "/timeline/", label: "Timeline", icon: ScrollText, description: "Every depeg, freeze, and grade change", keywords: "timeline tape events history feed" },
      { href: "/upcoming/", label: "Upcoming", icon: Rocket, description: "Pre-launch stablecoins and launch dates", keywords: "upcoming launch pre-launch calendar new coins pipeline" },
      { href: "/pharoswatchbot/", label: "Alert Bot", icon: Send, description: "Telegram alerts for depegs and launches", keywords: "alert bot telegram notifications subscribe watch" },
    ],
  },
  {
    key: "pharos",
    label: "About Pharos",
    items: [
      START_HERE_NAV_ITEM,
      { href: "/about/", label: "About", icon: Info, description: "Scope, sources, and why Pharos exists", keywords: "about team independent sources mission" },
      { href: "/funding/", label: "Funding", icon: Heart, description: "Costs, donations, and sustainability", keywords: "funding donate support costs sponsor" },
      { href: "/changelog/", label: "Changelog", icon: PenLine, description: "Weekly release notes and updates", keywords: "changelog release notes what's new updates" },
      { href: "/blog/", label: "Blog", icon: BookOpen, description: "Product updates and the Pharos story", keywords: "blog posts articles announcements" },
      { href: "/api/", label: "API Access", icon: KeyRound, description: "Public API keys and endpoint reference", keywords: "api key developer access endpoint docs integration" },
      { href: "/status/", label: "Status", icon: MonitorCheck, description: "Live health of every data pipeline", keywords: "status health uptime pipeline outage" },
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
      {
        href: "/stablecoins/",
        label: "Stablecoin Directory",
        icon: Coins,
        description: "Browse every tracked stablecoin",
        keywords: "directory list all coins browse stablecoins tokens",
        // Coin profiles are the directory's leaves; the routes share no prefix.
        activePrefixes: ["/stablecoin/"],
      },
      { href: "/liquidity/", label: "Liquidity", icon: Waves, description: "DEX depth, durability, and peg support", keywords: "liquidity dex depth pool slippage" },
      { href: "/flows/", label: "Flows", icon: ArrowUpDown, description: "Mint and burn pressure by chain", keywords: "flows mint burn issuance redemption supply change" },
      { href: "/chains/", label: "Chains", icon: Layers, description: "Stablecoin share and health by chain", keywords: "chains network ethereum solana tron l2 by chain" },
      { href: "/alt-pegs/", label: "Non-USD Pegs", icon: Globe, description: "Market structure beyond the dollar", keywords: "non-usd euro eur gbp chf jpy brl gold alt pegs currency" },
    ],
  },
  {
    key: "risk",
    label: "Risk",
    items: [
      { href: "/freezewatch/", label: "FreezeWatch", icon: FreezeShieldIcon, description: "Issuer power to freeze your balance", keywords: "freeze blacklist seize censorship issuer control frozen" },
      { href: "/compliance/", label: "Compliance", icon: Landmark, description: "MiCA and GENIUS status, coin by coin", keywords: "compliance mica genius regulation regulated license authorized" },
      { href: "/dependency-map/", label: "Dependency Map", icon: Network, description: "Collateral graph of upstream risk", keywords: "dependency map contagion collateral graph exposure" },
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

/**
 * Active-state test shared by every chrome surface. A destination is active on
 * its own route, on any route beneath it, and on any route beneath one of its
 * `activePrefixes`. The dashboard only matches exactly.
 */
export function isNavItemActive(pathname: string | null | undefined, item: NavItem): boolean {
  const path = pathname ?? "/";
  if (item.external) return false;
  if (isRouteActive(path, item.href)) return true;
  return item.activePrefixes?.some((prefix) => isRouteActive(path, prefix)) ?? false;
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
