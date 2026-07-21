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
  KeyRound,
  BookOpen,
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
  TableProperties,
  ScrollText,
  Heart,
  Globe,
  Ship,
  Landmark,
  MonitorCheck,
  BookMarked,
  BookA,
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
  icon: LucideIcon;
  description?: string;
  external?: boolean;
}

export interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

const DASHBOARD_NAV_ITEM: NavItem = { href: "/", label: "Dashboard", icon: LayoutDashboard, description: "Live triage surface for market stress, rankings, and first-pass research" };

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "overview",
    label: "Overview",
    items: [
      DASHBOARD_NAV_ITEM,
      { href: "/stability-index/", label: "Stability Index", icon: LighthouseIcon, description: "Market-regime read for the stablecoin system" },
      { href: "/timeline/", label: "Timeline", icon: ScrollText, description: "Unified chronological event feed across depeg, freeze, and grade transitions" },
      { href: "/digest/", label: "Daily Digest", icon: Newspaper, description: "Daily editorial recap of the stablecoin market" },
      { href: "/pharoswatchbot/", label: "Alert Bot", icon: Send, description: "PharosWatchBot push alerts for depegs, DEWS shifts, launches, and the daily digest" },
    ],
  },
  {
    key: "markets",
    label: "Markets",
    items: [
      { href: "/liquidity/", label: "Liquidity", icon: Waves, description: "DEX depth, durability, and market support" },
      { href: "/flows/", label: "Mint/Burn Flows", icon: ArrowUpDown, description: "Configured issuance-chain mint and burn pressure" },
      { href: "/chains/", label: "Chains", icon: Layers, description: "Chain-by-chain stablecoin share, mix, and health" },
      { href: "/alt-pegs/", label: "Alt-Pegs", icon: Globe, description: "Market structure and cohort growth beyond dollar pegs" },
      { href: "/yield/", label: "Yield Intelligence", icon: CircleDollarSign, description: "Yield ranked after adjusting for stablecoin risk" },
      { href: "/upcoming/", label: "Upcoming", icon: Rocket, description: "Pre-launch stablecoins and launch-watch context" },
    ],
  },
  {
    key: "risk",
    label: "Risk",
    items: [
      { href: "/safety-scores/", label: "Safety Scores", icon: ShieldCheck, description: "Cross-market safety grades and contagion scenarios" },
      { href: "/depeg/", label: "Depeg/DDR", icon: Activity, description: "Live peg incidents, DEWS early warnings, DDR recovery outlooks, and reviews" },
      { href: "/freezewatch/", label: "FreezeWatch", icon: FreezeShieldIcon, description: "Issuer control over your stablecoin balance, surfaced live" },
      { href: "/compliance/", label: "Compliance", icon: Landmark, description: "MiCA authorization and GENIUS implementation status across tracked stablecoins" },
      { href: "/cemetery/", label: "Cemetery", icon: Skull, description: "Failed stablecoins and the lessons they left behind" },
    ],
  },
  {
    key: "analyze",
    label: "Analyze",
    items: [
      { href: "/screener/", label: "Screener", icon: SlidersHorizontal, description: "Multi-axis filter across every tracked stablecoin" },
      { href: "/dependency-map/", label: "Dependency Map", icon: Network, description: "Collateral graph for hidden upstream stablecoin risk" },
      { href: "/compare/", label: "Compare", icon: ArrowLeftRight, description: "Build a live peer set and judge substitutes side by side" },
      { href: "/portfolio/", label: "Portfolio Audit", icon: Wallet, description: "Look through your holdings as one combined stablecoin book" },
    ],
  },
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
    key: "reference",
    label: "Reference",
    items: [
      { href: "/methodology/", label: "Methodology", icon: BookOpen, description: "Reference manual for formulas, thresholds, and changelogs" },
      { href: "/coverage/", label: "Coverage", icon: TableProperties, description: "Truth surface for what each route can show per coin" },
      { href: "/about/", label: "About", icon: Info, description: "Scope, data sources, and why Pharos exists" },
      { href: "/funding/", label: "Funding", icon: Heart, description: "Running costs, supporter ledger, and public sustainability path" },
      { href: "/blog/", label: "Blog", icon: PenLine, description: "Product updates and the story of Pharos" },
    ],
  },
];

export const UTILITY_NAV_ITEMS: NavItem[] = [
  { href: "/api/", label: "API Access", icon: KeyRound, description: "Request a public API key and open the endpoint reference" },
  { href: "/changelog/", label: "Changelog", icon: ScrollText, description: "Weekly release notes and feature updates" },
  { href: "/status/", label: "System Status", icon: MonitorCheck, description: "Live health of every data pipeline and cron sync" },
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

export const DEFAULT_EXPANDED: Record<string, boolean> = {
  overview: true,
  markets: true,
  risk: true,
  analyze: false,
  learn: false,
  reference: false,
};

/** Bottom items (always shown at sidebar bottom) */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  { href: "/start/", label: "Start Here", icon: Compass, description: "Shortest route into the product for new or returning users" },
];

/** Sibling/companion experiences hosted at separate origins */
export const COMPANION_NAV_ITEMS: NavItem[] = [
  {
    href: "https://pharosville.pharos.watch/",
    label: "PharosVille",
    icon: Ship,
    description: "The stablecoin universe as a working harbor — DEWS zones at a glance",
    external: true,
  },
];

/** Flat list for use in header and command palette */
export const NAV_ITEMS: NavItem[] = [
  ...NAV_GROUPS.flatMap((g) => g.items),
  ...UTILITY_NAV_ITEMS,
  ...BOTTOM_NAV_ITEMS,
  ...COMPANION_NAV_ITEMS,
];
