import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowLeftRight,
  ArrowUpDown,
  BookMarked,
  BookOpen,
  Compass,
  Droplets,
  FileText,
  FlaskConical,
  Heart,
  Info,
  Layers,
  LayoutDashboard,
  Lightbulb,
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

export interface StartHereScore {
  name: string;
  fullName: string;
  question: string;
  inputs: string;
  cadence: string;
  methodologyHref: string;
  surfacedOn: string;
  surfacedHref: string;
  icon: LucideIcon;
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
    title: "Check the coin I already hold",
    description:
      "Search for the stablecoin in your wallet — USDC, USDT, DAI, USDe, PYUSD — and open its detail page for the safety grade, what backs it, and whether it's under stress right now.",
    mobileDescription: "Search USDC, USDT, DAI, USDe or another coin and open its safety, backing, and stress detail.",
    href: "/stablecoins/usd/",
    cta: "Search the directory",
    destinations: ["Directory", "Safety grade", "Live reserves"],
    icon: Search,
    tone: "frost",
  },
  {
    title: "Stress-test my portfolio",
    description:
      "Add your stablecoin mix to the portfolio view to see a blended risk grade, hidden shared-backing exposure, and how the basket holds up if one issuer fails.",
    mobileDescription: "Blend your stablecoins, see shared-backing exposure, and stress-test an issuer failure.",
    href: "/portfolio/",
    cta: "Open portfolio",
    destinations: ["Portfolio", "Dependency Map", "Contagion test"],
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
      "Use PharosWatchBot if you want Pharos to watch for price deviations, early warning shifts, and daily grade changes for you.",
    mobileDescription: "Use PharosWatchBot for price alerts, early warnings, and daily grade changes.",
    href: "/pharoswatchbot/",
    cta: "Set up bot alerts",
    destinations: ["PharosWatchBot", "Depeg alerts", "Daily updates"],
    icon: Send,
    tone: "violet",
  },
] as const;

// ── Proprietary scores (the actual differentiation) ──────────────────

export const START_HERE_SCORES: readonly StartHereScore[] = [
  {
    name: "PSI",
    fullName: "Pharos Stability Index",
    question: "Is the stablecoin market under stress right now?",
    inputs: "Active-depeg severity, market-cap breadth, DEWS stress breadth, 7-day market-cap trend.",
    cadence: "Refreshes every 30 minutes.",
    methodologyHref: "/methodology/#stability-index-methodology",
    surfacedOn: "Open the Stability Index",
    surfacedHref: "/stability-index/",
    icon: Compass,
  },
  {
    name: "DEWS",
    fullName: "Depeg Early Warning System",
    question: "Which coins are quietly building toward a depeg?",
    inputs:
      "Eight 0–100 sub-signals: supply contraction, pool stress, liquidity erosion, price confidence, cross-source divergence, blacklist activity, mint/burn flow, yield anomalies.",
    cadence: "Refreshes every 30 minutes. Bands: CALM, WATCH, ALERT, WARNING, DANGER.",
    methodologyHref: "/methodology/#pegscore-dews-methodology",
    surfacedOn: "Open the Depeg Tracker",
    surfacedHref: "/depeg/",
    icon: ShieldAlert,
  },
  {
    name: "Safety Score",
    fullName: "Composite risk grade (A+ to F)",
    question: "How risky is this stablecoin overall?",
    inputs:
      "Weighted composite: Liquidity/Exit (30%), Resilience (20%), Decentralization (15%), Dependency Risk (25%), multiplied by a peg-stability factor.",
    cadence: "Recomputed continuously from live inputs; bands A+ (87+) through F (0–39).",
    methodologyHref: "/methodology/#safety-scores-methodology",
    surfacedOn: "Open the Safety Scores leaderboard",
    surfacedHref: "/safety-scores/",
    icon: FlaskConical,
  },
  {
    name: "PYS",
    fullName: "Pharos Yield Score",
    question: "Which yield opportunities survive risk adjustment?",
    inputs:
      "Raw APY weighted against the underlying stablecoin's Safety Score, source freshness, benchmark context, and APY consistency.",
    cadence: "Recomputed when source yields refresh; ranks update live.",
    methodologyHref: "/methodology/#yield-intelligence-methodology",
    surfacedOn: "Open Yield Intelligence",
    surfacedHref: "/yield/",
    icon: TrendingUp,
  },
  {
    name: "Chain Health Score",
    fullName: "Per-chain 0–100 composite",
    question: "Which chains carry the safest stablecoin mix?",
    inputs:
      "Stablecoin quality, chain environment, dominance concentration, peg stability across hosted assets, backing diversity.",
    cadence: "Recomputed with each chain-snapshot lane.",
    methodologyHref: "/methodology/#chain-health-score",
    surfacedOn: "Open Stables per Chain",
    surfacedHref: "/chains/",
    icon: Layers,
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
    meaning:
      "Depeg Early Warning System. Per-coin 0–100 stress score from eight weighted sub-signals (supply contraction, pool stress, liquidity erosion, price confidence, cross-source divergence, blacklist activity, mint/burn flow, yield anomalies). Refreshes every 30 minutes; bands are CALM, WATCH, ALERT, WARNING, DANGER. Formula and bands in /methodology/.",
  },
  {
    term: "Safety Score",
    meaning:
      "Composite V9 risk grade rendered A+ to F across Backing, Exit, and Economic Control, with bounded aggregation and explicit peg, evidence, dependency, wrapper, track-record, and structural constraints. Required unbounded evidence gaps return NR. Surfaces on every detail page and the Safety Scores leaderboard.",
  },
  {
    term: "Report Card",
    meaning:
      "Per-coin grade artifact rendered on every detail page. Breaks the Safety Score down into its component pillars so you can see where a coin earns or loses points.",
  },
  {
    term: "Liquidity grade",
    meaning:
      "How easily you can exit a stablecoin on-chain. Letter grade (A+ to F) backed by a 0–100 score that blends TVL depth (30%), 24h volume (20%), pool quality (20%), durability (20%), and pair diversity (10%). Inputs read from Curve, Balancer, Uniswap V3, Aerodrome, Velodrome, and other tracked venues.",
  },
  {
    term: "Chain Health Score",
    meaning:
      "0–100 composite per chain combining stablecoin quality, chain environment, dominance concentration, peg stability across hosted assets, and backing diversity. The lede on /chains/.",
  },
  {
    term: "Dependency risk",
    meaning:
      "How much a stablecoin depends on other stablecoins or their backing assets — hidden exposure that can cascade during stress.",
  },
  {
    term: "PYS",
    meaning:
      "Pharos Yield Score. Risk-adjusted yield ranking that weights raw APY against the underlying stablecoin's Safety Score, source freshness, benchmark context, and APY consistency. Surfaces on the yield page and on every coin detail page that has live opportunities.",
  },
  {
    term: "PSI",
    meaning:
      "Pharos Stability Index. 0–100 ecosystem health score combining active-depeg severity, market-cap breadth, DEWS stress breadth, and 7-day market-cap trend. Refreshes every 30 minutes. Also surfaces as 'Stability Index' across the app.",
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
        title: "PharosWatchBot",
        description: "Push alerts for price deviations, early warning changes, and daily digest delivery.",
        href: "/pharoswatchbot/",
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
          "A+ to F grades across every tracked stablecoin from a weighted composite of liquidity, resilience, decentralization, dependency risk, and peg stability — with live reserve feeds and redemption-backstop quality folded in.",
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
        description:
          "Live V9 dependency graph showing which stablecoins inherit serial or basket exposure from other assets and shared backing.",
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
        description:
          "Issuance-chain mint and burn monitoring with the Bank Run Gauge: a market-cap-weighted −100/+100 pressure signal against each coin's trailing 30-day baseline.",
        href: "/flows/",
        icon: ArrowUpDown,
      },
      {
        title: "FreezeWatch",
        description:
          "Live issuer intervention ledger — freeze, unfreeze, pause, block, wipe — across supported contracts and chains, with on-chain proof links and chain-specific amount provenance where available.",
        href: "/freezewatch/",
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
        title: "Stablecoin mechanism explainers",
        description: "Plain-English explainers of each stablecoin design pattern Pharos tracks.",
        href: "/learn/mechanisms/",
        icon: Lightbulb,
      },
      {
        title: "Stablecoin depeg case studies",
        description: "Long-form retrospectives on the failures, stress events, and recovery paths that shaped the market.",
        href: "/learn/case-studies/",
        icon: BookMarked,
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
          "Retrospective ledger of dead, discontinued, and frozen stablecoins — algorithmic failures, rug pulls, regulatory shutdowns, quiet abandonments. The validation track for the methodology, not a museum.",
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
    description: "Use PharosWatchBot when you want Pharos to keep watching after you leave the site.",
    detail: "Best for price deviation alerts, early warning changes, digest delivery, and daily safety-grade moves.",
    href: "/pharoswatchbot/",
    cta: "Configure alerts",
    icon: Send,
  },
] as const;
