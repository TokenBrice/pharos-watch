import type { ReactNode } from "react";
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Briefcase,
  Droplets,
  Flame,
  FlaskConical,
  Gauge,
  Globe,
  Network,
  Newspaper,
  Rocket,
  Ship,
  ShieldAlert,
  Skull,
  TrendingUp,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import { CAUSE_LABEL_LIST } from "@shared/lib/cause-of-death";

export interface AboutFeatureItem {
  title: string;
  description: ReactNode;
  icon: LucideIcon;
  href?: string;
  external?: boolean;
  linkLabel?: string;
  metaLabel?: string;
}

interface AboutStablecoinCounts {
  activeStablecoins: number;
  deadStablecoins: number;
  preLaunchStablecoins: number;
}

export interface AboutFaqItem {
  question: string;
  answer: string;
}

export interface AboutTeamMember {
  name: string;
  role: string;
  imageSrc: string;
}

export interface AboutDataPipelineStep {
  step: number;
  ariaLabel: string;
  title: string;
  description: string;
}

export function getAboutLeadParagraphs({
  activeStablecoins,
}: Pick<AboutStablecoinCounts, "activeStablecoins">): string[] {
  return [
    "Most trackers show price. Pharos shows risk.",
    `Live reserve feeds where a reviewed adapter exists, forward-looking depeg warnings across a ${activeStablecoins}-asset core universe of stablecoins, and public blacklist monitoring: everything that could make a stable asset fail.`,
  ];
}

export const DATA_SOURCE_GROUPS = [
  {
    label: "Supply & price",
    summary: "Market aggregators, centralized exchanges, on-chain oracles, NAV publishers, and direct DEX quotes.",
    sources:
      "DefiLlama, CoinGecko, GeckoTerminal, CoinMarketCap, DexScreener, DexPaprika, Alchemy Prices API, Moralis Token Prices, Birdeye, Jupiter Price API, Binance, Kraken spot, Bitstamp, Coinbase, Kava Pricefeed, Chainlink NAV feeds, Superstate and JPMorgan money-market NAV feeds, Curve, Fluid, Balancer, Uniswap V2/V3/V4, Raydium, Orca, Meteora, PancakeSwap, Aerodrome, Velodrome, Aero, Mento, Zephyr Scanner, Movement REST, direct protocol redemption or FX-par quotes, and Hive internal market (HBD/HIVE), with a CoinGecko HIVE/USD conversion dependency (one soft CoinGecko-family observation, not two independent votes).",
    documentation: { label: "Hive market API documentation", href: "https://developers.hive.io/apidefinitions/#condenser_api.get_order_book" },
  },
  {
    label: "Reserve transparency",
    summary: "Issuer and protocol reserve APIs, third-party attestations, proof-of-reserve feeds, and direct on-chain vault reads.",
    sources:
      "Issuer and protocol reserve APIs, dashboards, proof-of-reserve feeds, independent accounting examinations, and direct on-chain vault reads including Circle, Tether, Paxos/KPMG, Ripple/Deloitte, First Digital Labs, SG-FORGE, Sky/MakerDAO, Ethena, Frax, Aave GHO, OpenEden, Origin, Reserve Protocol, Chainlink PoR/NAV oracles, Chronicle Proof of Asset, Morpho vaults, Spark, Curve, Pendle, Accountable, Axis, MegaUSD, Coinbase ONED, Wyoming FRNT, and direct bridge/custodian balance reads.",
  },
  {
    label: "On-chain reads & events",
    summary: "Block explorers, multi-chain RPC providers, and pinned contract reads for supply, freezes, and mint/burn flows.",
    sources:
      "Dwellir, Alchemy, dRPC, Etherscan v2, TronGrid, selected public EVM and non-EVM RPC/indexer endpoints (Solana, Starknet, Sui, Aptos, Stellar Horizon/Soroban, Noble LCD, XRPL, Initia, ICP), pinned vault and redemption-queue contract reads, and reconciled freeze-ledger bootstrap records from kyc.rip / stables.rip.",
  },
  {
    label: "Reference data",
    summary: "Chain-risk snapshots, central-bank FX feeds, commodity marks, and currency benchmark rates.",
    sources:
      "eurostablecoins.xyz, L2BEAT chain-risk and Interop snapshots, Chainlink Data Feeds, ECB (Frankfurter and ECB Data API), Open Exchange Rates, fawazahmed0/currency-api, ExchangeRate-API, gold-api.com, FRED, New York Fed EFFR, Treasury.gov, SIX SARON, Bank of England SONIA, Bank of Japan, Banxico CETES, BCB SELIC, Reserve Bank of Australia, Bank of Canada CORRA, Central Bank of Russia, and CBRT TLREF.",
  },
  {
    label: "Regulatory registers",
    summary: "EU MiCA and national authority registers alongside U.S. GENIUS Act rulemaking and issuer disclosures.",
    sources:
      "ESMA MiCA registers, EBA EMT/ART registers, national competent authority registers (ACPR REGAFI, DNB/AFM, BaFin, MFSA, CBI, Bank of Lithuania), plus U.S. GENIUS Act implementation materials from the OCC, FDIC, FinCEN/OFAC, U.S. Treasury, Federal Register, and issuer reserve disclosures.",
  },
  {
    label: "DEX data",
    summary: "Yield and liquidity APIs, subgraphs, and direct pool reads across DEXs and lending markets.",
    sources:
      "DeFiLlama Yields & Protocols, protocol-native yield APIs and on-chain readers (Morpho, Aave V3, Compound V3, Yearn Kong, Beefy, Pendle, Curve, Hashnote, Re Protocol, Royco Dawn), The Graph, Curve Finance API and Curve Lite on Monad, Fluid pool states and tickers, Balancer, Raydium, Orca, Jupiter, Meteora, Bluefin, Stellar Horizon, Aquarius, TzKT, Balanced, Kava, SundaeSwap, PancakeSwap, SUN.io, Uniswap V3/V4, Aerodrome, Velodrome, Aero, Shadow Exchange, GeckoTerminal, and DexScreener.",
  },
  {
    label: "AI generation",
    summary: "Anthropic Claude drafts the daily digest and Monday weekly recap from captured Pharos snapshots.",
    sources: "Anthropic Claude (daily digest and Monday weekly recap, grounded in captured Pharos pipeline snapshots).",
  },
] as const;

export const TEAM_MEMBERS = [
  { name: "TokenBrice", role: "Creator", imageSrc: "/tokenbrice.png" },
  { name: "Ike", role: "Champion", imageSrc: "/ike.jpg" },
  { name: "Claude", role: "AI Brainstormer", imageSrc: "/claude.png" },
  { name: "Codex", role: "AI Engineer", imageSrc: "/codex.svg" },
] as const satisfies readonly AboutTeamMember[];

export const DATA_PIPELINE_STEPS = [
  {
    step: 1,
    ariaLabel: "Step 1: Sources",
    title: "Sources",
    description: "Market, on-chain, ratings, FX, commodity, and digest inputs are collected on a fixed schedule.",
  },
  {
    step: 2,
    ariaLabel: "Step 2: Cloudflare Worker + D1",
    title: "Cloudflare Worker + D1",
    description:
      "Staggered 5-minute, 15-minute, 30-minute, hourly, multi-hour, daily, and monthly lanes normalize the data, preserve independent protocol evidence in DEX price challenges before bounded TVL coverage selection, and cache the results for the public API.",
  },
  {
    step: 3,
    ariaLabel: "Step 3: Static dashboard",
    title: "Static dashboard",
    description:
      "Next.js pages on Cloudflare Pages consume the worker outputs and render the stablecoin view without direct third-party calls.",
  },
] as const satisfies readonly AboutDataPipelineStep[];

export const COMPUTED_FEATURES: readonly AboutFeatureItem[] = [
  {
    title: "Daily Digest",
    description:
      "A daily briefing on stablecoin market conditions covering supply shifts, depeg alerts, and liquidity changes.",
    icon: Newspaper,
    href: "/digest/",
    linkLabel: "Open digest",
  },
  {
    title: "Pharos Stability Index (PSI)",
    description:
      "A 30-minute ecosystem health score that combines active-depeg severity, market-cap breadth, DEWS stress breadth, and 7-day market-cap trend across core stablecoins, excluding tracked variants, tokenized funds, and review-hold listings.",
    icon: Gauge,
    href: "/stability-index/",
    linkLabel: "Open stability index",
  },
  {
    title: "Safety grades",
    description:
      "Composite A+ to F grades built from Backing, Exit, and Economic Control, followed by peg, deployment, and binding-cap adjustments.",
    icon: FlaskConical,
    href: "/safety-scores/",
    linkLabel: "Open scorecards",
  },
  {
    title: "Dependency Map",
    description:
      "Explore mapped collateral and wrapper dependencies. Exposure mode traces linked coins using publication-bound supply, without estimating losses or changes in Safety Scores.",
    icon: Network,
    href: "/dependency-map/",
    linkLabel: "Open dependency map",
  },
  {
    title: "Depeg Early Warning (DEWS)",
    description:
      "A per-coin stress score refreshed every 30 minutes from supply velocity, pool balance drift, liquidity erosion, price confidence, source divergence, blacklist activity, mint and burn flow, and yield anomalies.",
    icon: ShieldAlert,
    href: "/depeg/",
    linkLabel: "Open DEWS",
  },
  {
    title: "Stablecoin comparison",
    description:
      "Side-by-side analysis of any tracked stablecoins across safety, liquidity, peg stability, and yield metrics.",
    icon: ArrowLeftRight,
    href: "/compare/",
    linkLabel: "Open comparison",
  },
  {
    title: "Risk-adjusted yield",
    description:
      "Yield opportunities scored against stablecoin safety, benchmark context, source freshness, and APY consistency.",
    icon: TrendingUp,
    href: "/yield/",
    linkLabel: "Open yield intelligence",
  },
];

export const COMPANION_FEATURES: readonly AboutFeatureItem[] = [
  {
    title: "PharosVille",
    description:
      "A pixel-art harbor view of the same data. Every coin sails as a ship; DEWS zones become anchorages, breakwaters, and warning shoals: the classification you read in tables, drawn as a place. Best on desktop.",
    icon: Ship,
    href: "https://pharosville.pharos.watch/",
    external: true,
    linkLabel: "Explore PharosVille",
  },
];

export function getTrackedFeatures({
  activeStablecoins,
  deadStablecoins,
  preLaunchStablecoins,
}: AboutStablecoinCounts): AboutFeatureItem[] {
  return [
    {
      title: `${activeStablecoins} core stablecoins`,
      description:
        "Core stablecoins across supported chains, with tracked variants and tokenized funds classified and browsable separately.",
      icon: BarChart3,
      metaLabel: "Catalog",
    },
    {
      title: `${preLaunchStablecoins} upcoming stablecoins`,
      description:
        "Pre-launch projects tracked from announcement to launch, with milestones, timelines, and featured content.",
      icon: Rocket,
      href: "/upcoming/",
      linkLabel: "View upcoming",
    },
    {
      title: `${deadStablecoins} coins in the Cemetery`,
      description: `Dead stablecoins filed by cause of death (${CAUSE_LABEL_LIST}), each with an obituary and source.`,
      icon: Skull,
      href: "/cemetery/",
      linkLabel: "Open cemetery",
    },
    {
      title: "Failure scenarios",
      description:
        "On selected coins, a curated narrative of one hypothetical way the coin could break: each step, the safeguard missing at it, who could stop it, and what would invalidate the story. Every scenario is approved by a maintainer and re-checked on a schedule. It is not a simulator and never changes a Safety Score.",
      icon: Unlink,
      href: "/learn/scenarios/",
      linkLabel: "Browse scenarios",
    },
    {
      title: "FreezeWatch",
      description:
        "Live view of issuer-intervention events (freeze, unfreeze, pause, block, and wipe) across supported contracts and chains, with chain-specific amount provenance where available.",
      icon: ShieldAlert,
      href: "/freezewatch/",
      linkLabel: "Open FreezeWatch",
    },
    {
      title: "Peg Tracker",
      description:
        "Composite peg scores, depeg event detection, heatmaps, and four years of depeg history on the dedicated tracker.",
      icon: Activity,
      href: "/depeg/",
      linkLabel: "Open depeg tracker",
    },
    {
      title: "DEX liquidity",
      description: "Pool depth, volume, quality-adjusted TVL, durability, and pair diversity scored 0-100.",
      icon: Droplets,
      href: "/liquidity/",
      linkLabel: "Open liquidity tracker",
    },
    {
      title: "Chain analytics",
      description:
        "Per-chain stablecoin supply totals, 24h/7d/30d trends, composition breakdowns, and a Chain Health Score across quality, chain environment, concentration, peg stability, and backing diversity.",
      icon: Globe,
      href: "/chains/",
      linkLabel: "Open chain leaderboard",
    },
    {
      title: "Mint and burn flows",
      description:
        "Admitted issuance-chain mint and burn monitoring via Dwellir, Alchemy and TronGrid JSON-RPC, including USDT Tron Issue/Redeem after 90-day admission, the Bank Run Gauge and flight-to-quality detection.",
      icon: Flame,
      href: "/flows/",
      linkLabel: "Open flow tracker",
    },
    {
      title: "Portfolio audit",
      description:
        "Analyze your stablecoin holdings against Pharos safety, liquidity, and peg data to spot concentration risk.",
      icon: Briefcase,
      href: "/portfolio/",
      linkLabel: "Open portfolio",
    },
  ];
}

export function getAboutFaqItems({
  activeStablecoins,
  deadStablecoins,
}: Pick<AboutStablecoinCounts, "activeStablecoins" | "deadStablecoins">): AboutFaqItem[] {
  return [
    {
      question: "Why does Pharos exist?",
      answer:
        "Pharos is a project by TokenBrice, Ike, Claude, and Codex. It puts the stablecoin data you want to monitor in one place: honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
    },
    {
      question: "What does Pharos track?",
      answer: `Pharos uses ${activeStablecoins} core stablecoins for ecosystem market aggregates, while keeping tracked variants and tokenized funds visible as separate listing classes. It documents ${deadStablecoins} dead stablecoins in the cemetery, monitors issuer freeze and blacklist events on-chain, provides peg scores and depeg heatmaps, scores DEX liquidity, computes a 30-minute Pharos Stability Index, and publishes risk report cards.`,
    },
    {
      question: "How does Pharos classify stablecoins?",
      answer:
        "Pharos classifies stablecoins into three governance tiers: CeFi (fully centralized), CeFi-Dependent (decentralized infrastructure but reliant on centralized collateral or peg mechanisms), and DeFi (fully on-chain, no centralized custody dependency). This reflects actual infrastructure dependency, not marketing claims.",
    },
    {
      question: "Where does Pharos get its data?",
      answer:
        "Pharos aggregates data from DefiLlama, CoinGecko, on-chain RPC nodes, Etherscan, TronGrid, protocol-native APIs, and public regulatory registers. Details on all data sources are available on the About page.",
    },
  ];
}
