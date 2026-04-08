import type { LucideIcon } from "lucide-react";
import {
  Activity,
  LayoutDashboard,
  Droplets,
  Compass,
  ShieldBan,
  Skull,
  Info,
  Layers,
  KeyRound,
  BookOpen,
  FlaskConical,
  ArrowLeftRight,
  ArrowUpDown,
  Newspaper,
  Rocket,
  Send,
  Wallet,
  Network,
  TrendingUp,
  TableProperties,
  ScrollText,
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

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description?: string;
}

export interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

const DASHBOARD_NAV_ITEM: NavItem = { href: "/", label: "Dashboard", icon: LayoutDashboard, description: "Live triage surface for market stress, rankings, and first-pass research" };

export const PRIMARY_NAV_ITEMS: NavItem[] = [
  DASHBOARD_NAV_ITEM,
  { href: "/stability-index", label: "Stability Index", icon: LighthouseIcon, description: "Market-regime read for the stablecoin system" },
  { href: "/safety-scores", label: "Safety Scores", icon: FlaskConical, description: "Cross-market safety grades and contagion scenarios" },
  { href: "/yield", label: "Risk-Adjusted Yield", icon: TrendingUp, description: "Yield ranked after adjusting for stablecoin risk" },
  { href: "/telegram", label: "Telegram", icon: Send, description: "Push alerts for depegs, DEWS shifts, and the daily digest" },
];

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "data",
    label: "TRACK",
    items: [
      { href: "/chains/", label: "Stable per Chain", icon: Layers, description: "Chain-by-chain stablecoin share, mix, and health" },
      { href: "/liquidity", label: "Liquidity", icon: Droplets, description: "DEX depth, durability, and market support" },
      { href: "/depeg", label: "Depeg", icon: Activity, description: "Live incident board for peg stress and early warnings" },
      { href: "/flows", label: "Mint/Burn Flows", icon: ArrowUpDown, description: "Configured issuance-chain mint and burn pressure" },
      { href: "/blacklist", label: "Blacklist", icon: ShieldBan, description: "Freeze activity and issuer control events" },
      { href: "/upcoming", label: "Upcoming", icon: Rocket, description: "Pre-launch stablecoins and launch-watch context" },
      { href: "/cemetery", label: "Cemetery", icon: Skull, description: "Failed stablecoins and the lessons they left behind" },
    ],
  },
  {
    key: "tools",
    label: "Analyze",
    items: [
      { href: "/portfolio", label: "Portfolio Audit", icon: Wallet, description: "Look through your holdings as one combined stablecoin book" },
      { href: "/compare", label: "Compare", icon: ArrowLeftRight, description: "Build a live peer set and judge substitutes side by side" },
      { href: "/dependency-map", label: "Dependency Map", icon: Network, description: "Collateral graph for hidden upstream stablecoin risk" },
      { href: "/digest", label: "Digest", icon: Newspaper, description: "Daily editorial recap of the stablecoin market" },
    ],
  },
  {
    key: "info",
    label: "Reference",
    items: [
      { href: "/about", label: "About", icon: Info, description: "Scope, data sources, and why Pharos exists" },
      { href: "/methodology", label: "Methodology", icon: BookOpen, description: "Reference manual for formulas, thresholds, and changelogs" },
      { href: "/coverage", label: "Coverage", icon: TableProperties, description: "Truth surface for what each route can show per coin" },
      { href: "/about/api", label: "API Reference", icon: KeyRound, description: "Auth model, key requirement, and full endpoint reference" },
      { href: "/status", label: "Status", icon: Activity, description: "Live health of every data pipeline and cron sync" },
      { href: "/changelog", label: "Changelog", icon: ScrollText, description: "Weekly release notes and feature updates" },
    ],
  },
];

export const DEFAULT_EXPANDED: Record<string, boolean> = {
  data: false,
  tools: false,
  info: false,
};

/** Bottom items (always shown at sidebar bottom) */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  { href: "/start", label: "Start Here", icon: Compass, description: "Shortest route into the product for new or returning users" },
];

/** Flat list for use in header and command palette */
export const NAV_ITEMS: NavItem[] = [
  ...PRIMARY_NAV_ITEMS,
  ...NAV_GROUPS.flatMap((g) => g.items),
  ...BOTTOM_NAV_ITEMS,
];
