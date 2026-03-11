import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowLeftRight,
  ArrowUpDown,
  BookOpen,
  Compass,
  Droplets,
  FlaskConical,
  Info,
  LayoutDashboard,
  Network,
  Newspaper,
  Search,
  Send,
  ShieldAlert,
  ShieldBan,
  Skull,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { PEG_CURRENCY_COUNT } from "@shared/lib/classification";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

export interface StartHereGoal {
  title: string;
  description: string;
  href: string;
  cta: string;
  destinations: readonly string[];
  icon: LucideIcon;
  borderClass: string;
  spanClass: string;
}

export interface StartHereFact {
  value: string;
  label: string;
  detail: string;
}

export interface StartHereGlossaryItem {
  term: string;
  meaning: string;
}

export interface StartHerePath {
  title: string;
  audience: string;
  outcome: string;
  href: string;
  cta: string;
  borderClass: string;
  steps: readonly string[];
}

export interface StartHereAtlasItem {
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
}

export interface StartHereAtlasGroup {
  title: string;
  intro: string;
  borderClass: string;
  items: readonly StartHereAtlasItem[];
}

export interface StartHereShortcut {
  title: string;
  description: string;
  detail: string;
  href?: string;
  cta?: string;
  icon: LucideIcon;
  borderClass: string;
}

export const START_HERE_GOALS: readonly StartHereGoal[] = [
  {
    title: "Check market health",
    description: "Start with the dashboard, then read PSI and current peg stress before you zoom into any one asset.",
    href: "/",
    cta: "Open dashboard",
    destinations: ["Dashboard", "Stability Index", "Depeg Tracker"],
    icon: LayoutDashboard,
    borderClass: "border-l-cyan-500",
    spanClass: "sm:col-span-2",
  },
  {
    title: "Research one stablecoin",
    description: "Use the directory as your launch point, then open the coin page, safety grade, liquidity view, and dependency context.",
    href: "/stablecoins/usd/",
    cta: "Browse the directory",
    destinations: ["Directory", "Detail page", "Safety + Liquidity"],
    icon: Search,
    borderClass: "border-l-sky-500",
    spanClass: "",
  },
  {
    title: "Compare several coins",
    description: "Build a shortlist side by side and pressure-test it with the portfolio lens before you commit size.",
    href: "/compare/",
    cta: "Open compare",
    destinations: ["Compare", "Portfolio", "Safety Scores"],
    icon: ArrowLeftRight,
    borderClass: "border-l-emerald-500",
    spanClass: "",
  },
  {
    title: "Find safer yield",
    description: "Start from ranked opportunities, then verify the underlying stablecoin risk instead of optimizing for APY alone.",
    href: "/yield/",
    cta: "Open yield intelligence",
    destinations: ["Yield", "Safety Scores", "Coin detail"],
    icon: TrendingUp,
    borderClass: "border-l-amber-500",
    spanClass: "",
  },
  {
    title: "Set up alerts",
    description: "Use Telegram if you want Pharos to watch depegs, DEWS band shifts, and daily grade changes for you.",
    href: "/telegram/",
    cta: "Set up Telegram alerts",
    destinations: ["Telegram", "Depeg alerts", "Daily updates"],
    icon: Send,
    borderClass: "border-l-violet-500",
    spanClass: "sm:col-span-2",
  },
] as const;

export const START_HERE_FACTS: readonly StartHereFact[] = [
  {
    value: String(TRACKED_STABLECOINS.length),
    label: "tracked stablecoins",
    detail: "Major fiat issuers, DeFi-native names, non-USD pegs, and metal-backed assets.",
  },
  {
    value: String(PEG_CURRENCY_COUNT),
    label: "peg currencies",
    detail: "USD, EUR, GBP, gold, silver, and more in one classification system.",
  },
  {
    value: "15m",
    label: "core refresh cadence",
    detail: "Dashboard, PSI, DEWS, and depeg monitoring are built for active market surveillance.",
  },
  {
    value: String(DEAD_STABLECOINS.length),
    label: "failure case studies",
    detail: "The cemetery keeps historical collapse patterns close to the live research surface.",
  },
] as const;

export const START_HERE_GLOSSARY: readonly StartHereGlossaryItem[] = [
  {
    term: "Peg score",
    meaning: "How tightly a stablecoin has held its target over time, including penalties for real depeg events.",
  },
  {
    term: "DEWS",
    meaning: "The early warning layer. It looks for stress before a full depeg is obvious.",
  },
  {
    term: "Safety score",
    meaning: "The composite risk grade that rolls peg behavior, liquidity, resilience, decentralization, and dependency into one view.",
  },
  {
    term: "Liquidity score",
    meaning: "A 0-100 read on how much usable on-chain swap depth and protocol support a coin has.",
  },
  {
    term: "Dependency risk",
    meaning: "How much a stablecoin secretly leans on other stablecoins or upstream collateral structures.",
  },
  {
    term: "PYS",
    meaning: "Pharos Yield Score. It adjusts raw yield for the safety of the asset producing that yield.",
  },
  {
    term: "PSI",
    meaning: "Pharos Stability Index. It is the market-wide stress barometer for the whole stablecoin system.",
  },
] as const;

export const START_HERE_PATHS: readonly StartHerePath[] = [
  {
    title: "In 60 seconds",
    audience: "Best for first-time visitors and quick morning scans.",
    outcome: "You leave knowing whether the market is calm, where stress is showing up, and whether to dig deeper.",
    href: "/",
    cta: "Run the fast scan",
    borderClass: "border-l-cyan-500",
    steps: ["Dashboard", "Stability Index", "Depeg Tracker"],
  },
  {
    title: "Research one coin",
    audience: "Best for due diligence before using a new stablecoin.",
    outcome: "You see structure, risk grade, liquidity support, and hidden upstream dependencies before you size in.",
    href: "/stablecoins/usd/",
    cta: "Start from the directory",
    borderClass: "border-l-sky-500",
    steps: ["Directory or search", "Coin detail", "Safety, liquidity, dependency"],
  },
  {
    title: "Build a shortlist",
    audience: "Best when choosing between two to five candidates.",
    outcome: "You compare metrics side by side, then test what your mix still concentrates into.",
    href: "/compare/",
    cta: "Build a comparison set",
    borderClass: "border-l-emerald-500",
    steps: ["Compare", "Portfolio", "Telegram alerts"],
  },
  {
    title: "Yield with guardrails",
    audience: "Best for users who care about APY but do not want to lose risk context.",
    outcome: "You rank opportunities by risk-adjusted yield, then confirm the stablecoin itself deserves trust.",
    href: "/yield/",
    cta: "Review yield opportunities",
    borderClass: "border-l-amber-500",
    steps: ["Yield Intelligence", "Safety Scores", "Coin detail"],
  },
] as const;

export const START_HERE_ATLAS: readonly StartHereAtlasGroup[] = [
  {
    title: "Monitor",
    intro: "Use these when you want the market picture first and the narrative second.",
    borderClass: "border-l-cyan-500",
    items: [
      {
        title: "Dashboard",
        description: "Fastest live overview of the stablecoin market.",
        href: "/",
        icon: LayoutDashboard,
      },
      {
        title: "Stability Index",
        description: "PSI trend and condition bands for ecosystem-wide stress.",
        href: "/stability-index/",
        icon: Compass,
      },
      {
        title: "Depeg Tracker",
        description: "Live deviations, DEWS scores, and event history.",
        href: "/depeg/",
        icon: ShieldAlert,
      },
      {
        title: "Daily Digest",
        description: "Narrative recap when you want the day's story, not just the raw tables.",
        href: "/digest/",
        icon: Newspaper,
      },
      {
        title: "Telegram Alerts",
        description: "Push delivery for depegs, DEWS shifts, and digest updates.",
        href: "/telegram/",
        icon: Send,
      },
    ],
  },
  {
    title: "Research",
    intro: "Use these when you are evaluating one asset or trying to understand what sits underneath it.",
    borderClass: "border-l-sky-500",
    items: [
      {
        title: "Stablecoin directory",
        description: "Searchable launch point into the tracked universe and each detail page.",
        href: "/stablecoins/usd/",
        icon: Search,
      },
      {
        title: "Safety Scores",
        description: "Cross-market risk grades and contagion simulation.",
        href: "/safety-scores/",
        icon: FlaskConical,
      },
      {
        title: "DEX Liquidity",
        description: "On-chain depth, pool quality, and protocol support.",
        href: "/liquidity/",
        icon: Droplets,
      },
      {
        title: "Dependency Map",
        description: "Collateral graph for upstream stablecoin exposure.",
        href: "/dependency-map/",
        icon: Network,
      },
    ],
  },
  {
    title: "Operate",
    intro: "Use these when you are deciding, sizing, or actively monitoring flows and issuer behavior.",
    borderClass: "border-l-emerald-500",
    items: [
      {
        title: "Compare",
        description: "Side-by-side comparison for up to five assets.",
        href: "/compare/",
        icon: ArrowLeftRight,
      },
      {
        title: "Portfolio",
        description: "Weighted grade and upstream exposure for your own mix.",
        href: "/portfolio/",
        icon: Wallet,
      },
      {
        title: "Mint/Burn Flows",
        description: "Issuance, redemption, and pressure-shift monitoring.",
        href: "/flows/",
        icon: ArrowUpDown,
      },
      {
        title: "Blacklist Tracker",
        description: "Issuer intervention and freeze events across supported chains.",
        href: "/blacklist/",
        icon: ShieldBan,
      },
      {
        title: "Yield Intelligence",
        description: "Risk-adjusted yield rankings and warning signals.",
        href: "/yield/",
        icon: TrendingUp,
      },
    ],
  },
  {
    title: "Learn",
    intro: "Use these when you want the framework, provenance, or historical perspective behind the live data.",
    borderClass: "border-l-violet-500",
    items: [
      {
        title: "Methodology",
        description: "Reference manual for formulas, thresholds, and changelogs.",
        href: "/methodology/",
        icon: BookOpen,
      },
      {
        title: "About",
        description: "What Pharos tracks and where the data comes from.",
        href: "/about/",
        icon: Info,
      },
      {
        title: "Cemetery",
        description: "Failure patterns from dead and discontinued stablecoins.",
        href: "/cemetery/",
        icon: Skull,
      },
    ],
  },
] as const;

export const START_HERE_SHORTCUTS: readonly StartHereShortcut[] = [
  {
    title: "Search fast",
    description: "Press Ctrl/Cmd+K from anywhere to jump straight to a coin page or route.",
    detail: "Best when you already know the ticker and do not want to navigate manually.",
    icon: Search,
    borderClass: "border-l-cyan-500",
  },
  {
    title: "Browse by taxonomy",
    description: "Use the peg, backing, and governance landing pages when you want to scan a category instead of a ticker.",
    detail: "Good for questions like 'show me EUR stablecoins' or 'which DeFi names are crypto-backed'.",
    href: "/stablecoins/usd/",
    cta: "Open the directory",
    icon: Activity,
    borderClass: "border-l-sky-500",
  },
  {
    title: "Set and forget",
    description: "Use Telegram when you want Pharos to keep watching after you leave the site.",
    detail: "Best for depegs, DEWS changes, digest delivery, and daily safety-grade moves.",
    href: "/telegram/",
    cta: "Configure alerts",
    icon: Send,
    borderClass: "border-l-violet-500",
  },
] as const;
