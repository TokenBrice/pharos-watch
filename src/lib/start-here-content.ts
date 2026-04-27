import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowLeftRight,
  ArrowUpDown,
  BookOpen,
  Compass,
  Droplets,
  FileText,
  FlaskConical,
  Heart,
  Info,
  Layers,
  LayoutDashboard,
  Network,
  Newspaper,
  Rocket,
  Search,
  Send,
  ShieldAlert,
  ShieldBan,
  Skull,
  TableProperties,
  TrendingUp,
  Wallet,
} from "lucide-react";

export interface StartHereGoal {
  title: string;
  description: string;
  mobileDescription?: string;
  href: string;
  cta: string;
  destinations: readonly string[];
  icon: LucideIcon;
  tone: "frost" | "emerald" | "amber" | "violet";
}

export interface StartHereGlossaryItem {
  term: string;
  meaning: string;
}

export interface StartHereAtlasItem {
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
}

export interface StartHereAtlasGroup {
  title: string;
  kickerLabel: string;
  intro: string;
  items: readonly StartHereAtlasItem[];
}

export interface StartHereShortcut {
  title: string;
  kickerLabel: string;
  description: string;
  detail: string;
  href?: string;
  cta?: string;
  icon: LucideIcon;
}

// ── Goal cards (plain language — no jargon before the glossary) ──────

export const START_HERE_GOALS: readonly StartHereGoal[] = [
  {
    title: "Check market health",
    description:
      "Start with the dashboard for a live market overview, then check whether any stablecoins are drifting from their target price.",
    mobileDescription: "Start with the dashboard for a live overview and current stress levels.",
    href: "/",
    cta: "Open dashboard",
    destinations: ["Dashboard", "Stability Index", "Depeg Tracker"],
    icon: LayoutDashboard,
    tone: "frost",
  },
  {
    title: "Research one stablecoin",
    description:
      "Use the directory to find any tracked stablecoin, then open its detail page for safety grades, liquidity, and risk breakdown.",
    mobileDescription: "Open the directory, then jump to any coin's detail, safety, and liquidity.",
    href: "/stablecoins/usd/",
    cta: "Browse the directory",
    destinations: ["Directory", "Detail page", "Safety + Liquidity"],
    icon: Search,
    tone: "frost",
  },
  {
    title: "Compare several coins",
    description:
      "Build a shortlist side by side and stress-test it with the portfolio view before making allocation decisions.",
    mobileDescription: "Build a shortlist side by side, then stress-test it in portfolio view.",
    href: "/compare/",
    cta: "Open compare",
    destinations: ["Compare", "Portfolio", "Safety Scores"],
    icon: ArrowLeftRight,
    tone: "emerald",
  },
  {
    title: "Find safer yield",
    description:
      "Start from ranked opportunities, then verify the underlying stablecoin risk instead of optimizing for APY alone.",
    mobileDescription: "Rank opportunities first, then verify the stablecoin before chasing APY.",
    href: "/yield/",
    cta: "Open yield intelligence",
    destinations: ["Yield", "Safety Scores", "Coin detail"],
    icon: TrendingUp,
    tone: "amber",
  },
  {
    title: "Set up alerts",
    description:
      "Use Telegram if you want Pharos to watch for price deviations, early warning shifts, and daily grade changes for you.",
    mobileDescription: "Use Telegram for price alerts, early warnings, and daily grade changes.",
    href: "/telegram/",
    cta: "Set up Telegram alerts",
    destinations: ["Telegram", "Depeg alerts", "Daily updates"],
    icon: Send,
    tone: "violet",
  },
] as const;

// ── Glossary (foundational terms first, then Pharos-specific) ────────

export const START_HERE_GLOSSARY: readonly StartHereGlossaryItem[] = [
  {
    term: "Peg",
    meaning:
      "The target price a stablecoin is designed to hold — usually $1 for USD stablecoins, but also EUR, GBP, gold, and other reference values.",
  },
  {
    term: "Depeg",
    meaning:
      "When a stablecoin's market price drifts away from its target. Small deviations are common; sustained or sharp moves are the danger signal.",
  },
  {
    term: "Peg stability",
    meaning:
      "How tightly a stablecoin has held its target over time, including penalties for real depeg events. Surfaces as a sub-factor inside the Safety Score, not as a standalone grade.",
  },
  {
    term: "DEWS",
    meaning: "Early warning system. Detects stress building in a stablecoin before a visible depeg event occurs.",
  },
  {
    term: "Safety Score",
    meaning:
      "The composite risk grade rendered as a letter (A+ to F). Blends peg stability, liquidity, resilience, decentralization, dependency, live reserves, and redemption-backstop quality into one view. Surfaced on every detail page and the Safety Scores leaderboard.",
  },
  {
    term: "Report Card",
    meaning:
      "Per-coin grade artifact rendered on every detail page. Breaks the Safety Score down into its component pillars so you can see where a coin earns or loses points.",
  },
  {
    term: "Liquidity grade",
    meaning:
      "How easily you can trade in or out of a stablecoin on-chain. Rendered as a letter grade (A+ to F) on directories and detail pages, with a 0–100 underlying score.",
  },
  {
    term: "Chain Health Score",
    meaning:
      "0–100 composite per chain, rolling stablecoin supply, dominance concentration, and infrastructure signals into one barometer. The lede on /chains/.",
  },
  {
    term: "Dependency risk",
    meaning:
      "How much a stablecoin depends on other stablecoins or their backing assets — hidden exposure that can cascade during stress.",
  },
  {
    term: "PYS",
    meaning: "Pharos Yield Score. Adjusts raw yield for the safety of the asset producing that yield.",
  },
  {
    term: "PSI",
    meaning:
      "Pharos Stability Index. The market-wide stress barometer for the whole stablecoin system. Updates every 30 minutes; also referenced as 'Stability Index' across the app.",
  },
  {
    term: "Frozen",
    meaning:
      "A tracked stablecoin whose data collection has been halted but whose detail page remains as a read-only archive. Different from cemetery entries: frozen coins still have their original page; cemetery entries are summarized obituaries only.",
  },
] as const;

// ── Feature atlas (jargon-free descriptions) ─────────────────────────

export const START_HERE_ATLAS: readonly StartHereAtlasGroup[] = [
  {
    title: "Monitor",
    kickerLabel: "Surveillance",
    intro: "Use these when you want the market picture first and the narrative second.",
    items: [
      {
        title: "Dashboard",
        description: "Fastest live overview of the stablecoin market.",
        href: "/",
        icon: LayoutDashboard,
      },
      {
        title: "Stability Index (PSI)",
        description: "Market-wide stress trend and risk condition bands, updated every 30 minutes.",
        href: "/stability-index/",
        icon: Compass,
      },
      {
        title: "Depeg Tracker",
        description: "Live price deviations from peg, early warning scores, and event history.",
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
        description: "Push alerts for price deviations, early warning changes, and daily digest delivery.",
        href: "/telegram/",
        icon: Send,
      },
      {
        title: "Stables per Chain",
        description: "Per-chain Chain Health Score (0–100) plus stablecoin supply, activity, and dominance.",
        href: "/chains/",
        icon: Layers,
      },
    ],
  },
  {
    title: "Research",
    kickerLabel: "Due diligence",
    intro: "Use these when you are evaluating one asset or trying to understand what sits underneath it.",
    items: [
      {
        title: "Stablecoin directory",
        description: "Searchable launch point into the tracked universe and each detail page.",
        href: "/stablecoins/usd/",
        icon: Search,
      },
      {
        title: "Safety Scores",
        description:
          "Risk grades across all tracked stablecoins, blending live reserve feeds, transitive dependency scoring, and redemption-backstop quality into letter grades.",
        href: "/safety-scores/",
        icon: FlaskConical,
      },
      {
        title: "Report Cards",
        description: "Per-coin grade breakdown shown on every detail page, with each Safety Score pillar isolated.",
        href: "/safety-scores/",
        icon: FileText,
      },
      {
        title: "DEX Liquidity",
        description: "How much swap depth each stablecoin has on decentralized exchanges.",
        href: "/liquidity/",
        icon: Droplets,
      },
      {
        title: "Dependency Map",
        description: "Visual map of which stablecoins depend on other stablecoins or shared backing.",
        href: "/dependency-map/",
        icon: Network,
      },
      {
        title: "Upcoming Stablecoins",
        description: "Pre-launch tracker with milestones and launch alerts.",
        href: "/upcoming/",
        icon: Rocket,
      },
    ],
  },
  {
    title: "Operate",
    kickerLabel: "Action",
    intro: "Use these when you are deciding, allocating, or actively monitoring flows and issuer behavior.",
    items: [
      {
        title: "Compare",
        description: "Side-by-side comparison for up to five assets.",
        href: "/compare/",
        icon: ArrowLeftRight,
      },
      {
        title: "Portfolio",
        description: "Blended risk grade and shared-backing exposure for your own stablecoin mix.",
        href: "/portfolio/",
        icon: Wallet,
      },
      {
        title: "Mint/Burn Flows",
        description: "Tracks when issuers create or destroy supply, and the market pressure that follows.",
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
    kickerLabel: "Reference",
    intro: "Use these when you want the methodology, history, or context behind the live data.",
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
        title: "Coverage",
        description: "Per-coin feature coverage matrix showing data completeness.",
        href: "/coverage/",
        icon: TableProperties,
      },
      {
        title: "Cemetery",
        description:
          "Failure patterns from dead, discontinued, and frozen stablecoins. Frozen entries link back to their preserved detail page.",
        href: "/cemetery/",
        icon: Skull,
      },
      {
        title: "Funding",
        description: "On-chain donations, running costs, and how Pharos stays freely accessible.",
        href: "/funding/",
        icon: Heart,
      },
    ],
  },
] as const;

// ── Power-move shortcuts ─────────────────────────────────────────────

export const START_HERE_SHORTCUTS: readonly StartHereShortcut[] = [
  {
    title: "Search fast",
    kickerLabel: "Navigation",
    description: "Press Ctrl/Cmd+K from anywhere to jump straight to a coin page or route.",
    detail: "Best when you already know the ticker and do not want to navigate manually.",
    icon: Search,
  },
  {
    title: "Browse by category",
    kickerLabel: "Discovery",
    description:
      "Use the peg, backing, and governance landing pages when you want to scan a category instead of a ticker.",
    detail: "Good for questions like 'show me EUR stablecoins' or 'which DeFi names are crypto-backed'.",
    href: "/stablecoins/usd/",
    cta: "Open the directory",
    icon: Activity,
  },
  {
    title: "Set and forget",
    kickerLabel: "Automation",
    description: "Use Telegram when you want Pharos to keep watching after you leave the site.",
    detail: "Best for price deviation alerts, early warning changes, digest delivery, and daily safety-grade moves.",
    href: "/telegram/",
    cta: "Configure alerts",
    icon: Send,
  },
] as const;
