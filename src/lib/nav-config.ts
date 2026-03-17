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
  BookOpen,
  FlaskConical,
  ArrowLeftRight,
  ArrowUpDown,
  Newspaper,
  Send,
  Wallet,
  Network,
  TrendingUp,
  TableProperties,
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

interface NavGroup {
  label: string;
  items: NavItem[];
}

export const DASHBOARD_NAV_ITEM: NavItem = { href: "/", label: "Dashboard", icon: LayoutDashboard, description: "Market overview and KPIs" };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Risk Lab",
    items: [
      { href: "/stability-index", label: "Stability Index", icon: LighthouseIcon, description: "Pharos Stability Index" },
      { href: "/safety-scores", label: "Safety Scores", icon: FlaskConical, description: "Safety grades and contagion simulation" },
      { href: "/yield", label: "Risk-Adjusted Yield", icon: TrendingUp, description: "Risk-adjusted yield rankings" },
    ],
  },
  {
    label: "Data",
    items: [
      { href: "/chains/", label: "Stable per Chain", icon: Layers, description: "Stablecoin activity per chain" },
      { href: "/liquidity", label: "Liquidity Tracker", icon: Droplets, description: "DEX liquidity analysis" },
      { href: "/depeg", label: "Depeg Tracker", icon: Activity, description: "Live peg monitoring & early warnings" },
      { href: "/flows", label: "Mint/Burn Flows", icon: ArrowUpDown, description: "Mint and burn flow tracker" },
      { href: "/blacklist", label: "Blacklist Tracker", icon: ShieldBan, description: "Frozen address events" },
    ],
  },
  {
    label: "Tools",
    items: [
      { href: "/portfolio", label: "Portfolio Audit", icon: Wallet, description: "Personal stablecoin risk view" },
      { href: "/compare", label: "Compare", icon: ArrowLeftRight, description: "Side-by-side comparison" },
      { href: "/dependency-map", label: "Dependency Map", icon: Network, description: "Stablecoin collateral dependency graph" },
      { href: "/telegram", label: "Telegram Alerts", icon: Send, description: "Bot commands & digest channel" },
    ],
  },
  {
    label: "Info",
    items: [
      { href: "/cemetery", label: "Cemetery", icon: Skull, description: "Dead stablecoins" },
      { href: "/digest", label: "Digest", icon: Newspaper, description: "Daily market digest" },
    ],
  },
  {
    label: "About Pharos",
    items: [
      { href: "/about", label: "About", icon: Info, description: "About Pharos" },
      { href: "/methodology", label: "Methodology", icon: BookOpen, description: "How Pharos grades stablecoins" },
      { href: "/coverage", label: "Coverage", icon: TableProperties, description: "Per-coin feature coverage matrix" },
    ],
  },
];

/** Flat list for use in header and command palette */
export const NAV_ITEMS: NavItem[] = [DASHBOARD_NAV_ITEM, ...NAV_GROUPS.flatMap((g) => g.items)];

/** Bottom items (always shown at sidebar bottom) */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  { href: "/start", label: "Start Here", icon: Compass, description: "Orientation for new users" },
];
