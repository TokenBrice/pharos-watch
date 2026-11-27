import { getRouteCapabilities } from "@/lib/route-capabilities";
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
  FileText,
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
  Sigma,
  TableProperties,
  Unlink,
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
   * Presentation-only short form for the desktop quick rail from 1280px (`xl:`)
   * to 1679px and the mobile bottom bar. Never the label a search/index consumer
   * should show — `NAV_ITEMS` is ordered so canonical entries win the dedupe.
   */
  shortLabel?: string;
  /**
   * Presentation-only narrowest form for the desktop quick rail below 1280px
   * (`lg:`, falls back to `shortLabel`). Same indexing caveat as `shortLabel`.
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

/** Stacked subsection of a menu panel (e.g., `pharos` project / trust / companion tiers). */
export interface NavSection {
  key: string;
  /** Subhead in the panel and the drawer; `null` for a panel's lead rows or companion band. */
  label: string | null;
  /**
   * Renders the section as a distinct full-bleed companion showcase band at the
   * foot of the panel (e.g., PharosVille), keeping its visible description and
   * full keyboard/screen-reader accessibility.
   */
  companion?: boolean;
  items: readonly NavItem[];
}

export interface NavGroup {
  key: string;
  label: string;
  /** Flat membership: active-state ownership, mobile drawer, and command palette. */
  items: readonly NavItem[];
  /** Panel layout. When present, `items` is exactly its flattening. */
  sections?: readonly NavSection[];
  /**
   * Quiet cross-reference links to related destinations promoted onto the quick
   * rail (not in `items`, so the menu trigger never double-highlights alongside
   * the active quick-rail item).
   */
  quickBarLinks?: readonly NavItem[];
}

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
  keywords: "safety score grade rating risk report card",
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
 * Full primary rail roster (six routes including Home). Mobile bottom nav reads
 * its four thumb-zone slots from this list via `route-capabilities.ts`, and
 * `NAV_ITEMS` seeds canonical rail entries ahead of the long tail.
 */
export const QUICK_NAV_ITEMS: readonly NavItem[] = [
  DASHBOARD_NAV_ITEM,
  { ...SAFETY_SCORES_NAV_ITEM, shortLabel: "Safety" },
  // "Yield" reads unambiguously at every width and keeps the rail inside the
  // masthead width budget; search still indexes the canonical group label.
  { ...YIELD_NAV_ITEM, label: "Yield", shortLabel: "Yield" },
  { ...DEPEG_NAV_ITEM, shortLabel: "Depeg" },
  // Retiring desktop Home frees enough width that Stability stays readable
  // down to 1024px (lg:), eliminating the double-"PSI" collision with the
  // RegimeBarToggle pill.
  { ...STABILITY_INDEX_NAV_ITEM, shortLabel: "Stability", compactLabel: "Stability" },
  { ...FREEZEWATCH_NAV_ITEM, shortLabel: "FreezeWatch", compactLabel: "Freeze" },
];

/**
 * Desktop quick rail (five routes): the top-left Pharos logo lockup already
 * links to `/`, so dropping the duplicate Home pill frees ~71–83px across every
 * desktop breakpoint to comfortably house the 5th Pharos menu alongside the
 * right-anchored section menus.
 *
 * Labels step down in three tiers: `compactLabel` below 1280px (`lg:`),
 * `shortLabel` from 1280px (`xl:`) to 1679px, and canonical `label` from
 * 1680px (`min-[105rem]:`).
 */
export const DESKTOP_QUICK_NAV_ITEMS: readonly NavItem[] = QUICK_NAV_ITEMS.filter(
  (item) => item.href !== "/",
);

const SCREENER_NAV_ITEM: NavItem = {
  href: "/screener/",
  label: "Screener",
  icon: SlidersHorizontal,
  description: "Filter every coin or run Guided Picker",
  keywords: "screener picker guided selector shortlist wizard filter find search criteria",
};

const COMPARE_NAV_ITEM: NavItem = {
  href: "/compare/",
  label: "Compare",
  icon: ArrowLeftRight,
  description: "Peer sets and substitutes side by side",
  keywords: "compare vs versus side by side alternative",
};

const PORTFOLIO_NAV_ITEM: NavItem = {
  href: "/portfolio/",
  label: "Portfolio",
  icon: Wallet,
  description: "Your holdings as one stablecoin book",
  keywords: "portfolio holdings my coins wallet exposure",
};

const ALERT_BOT_NAV_ITEM: NavItem = {
  href: "/pharoswatchbot/",
  label: "Alert Bot",
  icon: Send,
  description: "Telegram depeg, stress, and grade alerts",
  keywords: "alert bot telegram notifications subscribe watch dews depeg freeze grade",
};

/**
 * Mobile drawer pinned monitors: the two primary quick-rail monitors that do
 * not sit in the four-slot bottom bar (Home, Safety, Yield, Depeg stay one tap
 * away there). Tools live directly in the collapsible Tools group below so zero
 * Tools entries are duplicated.
 */
export const MOBILE_DRAWER_QUICK_ITEMS: readonly NavItem[] = [
  { ...STABILITY_INDEX_NAV_ITEM, shortLabel: "Stability" },
  FREEZEWATCH_NAV_ITEM,
];

const PHAROS_SECTIONS: readonly NavSection[] = [
  {
    key: "project",
    label: null,
    items: [
      { href: "/about/", label: "About", icon: Info, description: "Scope, sources, and why Pharos exists", keywords: "about team independent sources mission" },
      { href: "/funding/", label: "Funding", icon: Heart, description: "Costs, donations, and sustainability", keywords: "funding donate support costs sponsor" },
      { href: "/blog/", label: "Blog", icon: BookOpen, description: "Product updates and the Pharos story", keywords: "blog posts articles announcements" },
      { href: "/changelog/", label: "Changelog", icon: PenLine, description: "Weekly release notes and updates", keywords: "changelog release notes what's new updates" },
    ],
  },
  {
    key: "trust",
    label: "Trust & operations",
    items: [
      { href: "/coverage/", label: "Coverage", icon: TableProperties, description: "What Pharos tracks, coin by coin", keywords: "coverage tracked supported data availability" },
      { href: "/status/", label: "Status", icon: MonitorCheck, description: "Live health of every data pipeline", keywords: "status health uptime pipeline outage" },
    ],
  },
  {
    key: "companion",
    label: null,
    companion: true,
    items: [
      {
        href: "https://pharosville.pharos.watch/",
        label: "PharosVille",
        icon: Ship,
        description: "Explore the stablecoin universe as a live harbor",
        keywords: "pharosville harbor game visualization",
        external: true,
      },
    ],
  },
];

/**
 * Section menus group the long tail by reader intent:
 * - Markets: where supply lives and moves
 * - Risk: what can break and what already did
 * - Tools: act on the data
 * - Learn: pure educational & methodology reference
 * - Pharos: project identity, updates, operational transparency, and PharosVille
 *
 * Every row carries a visible one-line description so keyboard, touch, and
 * screen-reader users get the same guidance as pointer users.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: "markets",
    label: "Markets",
    items: [
      { href: "/liquidity/", label: "Liquidity", icon: Waves, description: "DEX depth, durability, and peg support", keywords: "liquidity dex depth pool slippage" },
      { href: "/flows/", label: "Mint & Burn", icon: ArrowUpDown, description: "Issuance and redemption flows by chain", keywords: "flows mint burn issuance redemption supply change" },
      { href: "/chains/", label: "Chains", icon: Layers, description: "Stablecoin share and health by chain", keywords: "chains network ethereum solana tron l2 by chain" },
      { href: "/alt-pegs/", label: "Non-USD Pegs", icon: Globe, description: "Market structure beyond the dollar", keywords: "non-usd euro eur gbp chf jpy brl gold alt pegs currency" },
      { href: "/upcoming/", label: "Upcoming", icon: Rocket, description: "Pre-launch stablecoins and launch dates", keywords: "upcoming launch pre-launch calendar new coins pipeline" },
      { href: "/digest/", label: "Daily Digest", icon: Newspaper, description: "Daily editorial recap of the market", keywords: "digest daily news recap newsletter today" },
    ],
    quickBarLinks: [
      { ...YIELD_NAV_ITEM, shortLabel: "Yield" },
      { ...STABILITY_INDEX_NAV_ITEM, shortLabel: "Stability Index" },
    ],
  },
  {
    key: "risk",
    label: "Risk",
    items: [
      { href: "/compliance/", label: "Compliance", icon: Landmark, description: "MiCA and GENIUS status, coin by coin", keywords: "compliance mica genius regulation regulated license authorized" },
      { href: "/dependency-map/", label: "Dependency Map", icon: Network, description: "Collateral and wrapper dependency graph", keywords: "dependency map contagion collateral wrapper graph exposure" },
      { href: "/cemetery/", label: "Cemetery", icon: Skull, description: "Failed stablecoins and their lessons", keywords: "cemetery dead failed collapsed defunct graveyard" },
      { href: "/timeline/", label: "Timeline", icon: ScrollText, description: "Every depeg, freeze, and grade change", keywords: "timeline tape events history feed" },
    ],
    quickBarLinks: [
      { ...SAFETY_SCORES_NAV_ITEM, shortLabel: "Safety Scores" },
      { ...DEPEG_NAV_ITEM, shortLabel: "Depeg & Recovery" },
      { ...FREEZEWATCH_NAV_ITEM, shortLabel: "FreezeWatch" },
    ],
  },
  {
    key: "tools",
    label: "Tools",
    items: [
      SCREENER_NAV_ITEM,
      COMPARE_NAV_ITEM,
      PORTFOLIO_NAV_ITEM,
      ALERT_BOT_NAV_ITEM,
      { href: "/api/", label: "API", icon: KeyRound, description: "Free grades, endpoints, and access keys", keywords: "api key developer access endpoint docs reference integration" },
    ],
  },
  {
    key: "learn",
    label: "Learn",
    items: [
      { href: "/learn/mechanisms/", label: "Mechanisms", icon: Lightbulb, description: "How each design holds its peg", keywords: "mechanism archetype design how it works collateral algorithmic" },
      { href: "/learn/case-studies/", label: "Case Studies", icon: BookMarked, description: "Retrospectives of major depegs", keywords: "case study retrospective post-mortem history terra ust svb" },
      { href: "/learn/scenarios/", label: "Failure Scenarios", icon: Unlink, description: "Hypothetical failure paths per coin", keywords: "failure scenarios how it breaks stress path attack vector falsifiers" },
      { href: "/methodology/", label: "Methodology", icon: Sigma, description: "Formulas, thresholds, and versions", keywords: "methodology formula threshold how computed calculated version glossary definitions terms" },
      { href: "/docs/", label: "Documentation", icon: FileText, description: "Technical methodology specs & Markdown", keywords: "docs documentation specs architecture data contracts markdown reference" },
    ],
  },
  {
    key: "pharos",
    label: "Pharos",
    sections: PHAROS_SECTIONS,
    items: PHAROS_SECTIONS.flatMap((section) => section.items),
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
  return getRouteCapabilities(pathname).home ? "top-0" : "top-[3px]";
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
