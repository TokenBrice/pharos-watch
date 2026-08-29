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
  Layers,
  Network,
  Newspaper,
  Rocket,
  Ship,
  ShieldAlert,
  ShieldCheck,
  Skull,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export interface AboutFeatureItem {
  title: string;
  description: ReactNode;
  icon: LucideIcon;
  href?: string;
  external?: boolean;
  linkLabel?: string;
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
    `Live reserve feeds, forward-looking depeg warnings, and public blacklist monitoring across a ${activeStablecoins}-asset core universe of stablecoins and cash equivalents — everything that could make a stable asset fail.`,
  ];
}

export const DATA_SOURCE_GROUPS = [
  {
    label: "Supply & Price",
    sources:
      "DefiLlama, CoinGecko, GeckoTerminal, CoinMarketCap, DexScreener, DexPaprika, Alchemy Prices API, Moralis Token Prices, Birdeye, Jupiter Price API, Binance, Kraken, Bitstamp, Coinbase, RedStone, Kava Pricefeed, Curve on-chain, Chainlink NAV reserve telemetry, Superstate NAV/liquidity telemetry, Flying Tulip's on-chain ftUSD reserve index, Fluid, Balancer, Curve, Uniswap V3, Uniswap V4, Raydium, Orca, Meteora, PancakeSwap, Aerodrome, Velodrome, Mento Broker, Citrea StablecoinBridge, Zephyr Scanner, Movement REST, direct protocol redemption or FX-par quotes, curated fail-closed on-chain supply-gap repairs, and V9 lockbox attribution reads",
  },
  {
    label: "Reserve Transparency",
    sources:
      "Issuer and protocol reserve APIs, dashboards, proof-of-reserve portals, issuer attestation indexes, and direct on-chain vault/accounting reads (including Ethena collateralization and proof-of-reserves measurements, plus reserve composition disclosures and live feeds from providers such as 3Jane, Anzen, Chronicle Proof of Asset, Falcon, Frankencoin, Hashnote, infiniFi, M0, Mento Reserve / analytics API, OpenEden, Origin, Blast, Nest Credit, Re, Resupply, Reserve Protocol, USDD, USD.AI, USD1 Chainlink bundle oracle, Backed (public assetReserves circulation feed), Accountable, Hyperbeat, Tether, Frax, Circle, First Digital Labs, Ripple, SG-FORGE, Paxos, Aura Partners, KPMG/SALVUS (Schuman Financial), Sky/MakerDAO, Chainlink PoR/NAV oracles, StraitsX / KK Yap & Associates, Kinesis, Quantoz, Yamato, Aave GHO, BIMA, SMARDEX, f(x), Asymmetry, JupUSD, Morpho vault liquidity, USDGO, Yield Optimizer, Yuzu, Solstice, River, Alloy, Zephyr Scanner, Spiko, United Stables, Polymarket PUSD vault reads, Gnosis xDAI bridge collateral reads, Hive consensus-state reads, and Curve/Yield Basis reserve reads where available)",
  },
  {
    label: "On-chain Reads & Events",
    sources:
      "Etherscan v2 (freeze events), TronGrid, Alchemy, dRPC, selected public chain RPCs (including MegaETH public RPC, EVM RPCs for configured mint/burn flows, direct Liquity/B.Protocol branch debt reads, and Frankencoin's ZCHF -> CHFAU StablecoinBridge balance probe, plus Solana mainnet RPC reads for tracked mint-supply validation), and reconciled freeze-ledger bootstrap rows from kyc.rip / stables.rip for major ETH and TRON blacklist coverage",
  },
  {
    label: "Ratings & Reference",
    sources:
      "Bluechip, eurostablecoins.xyz EUR stablecoin coverage, L2BEAT static chain-risk and Interop snapshots for Chain Health and reviewed Safety Score bridge-route context, Chainlink Data Feeds, ECB via Frankfurter, Open Exchange Rates (real-time FX cross-validation), fawazahmed0/currency-api (CNH and non-ECB FX), ExchangeRate-API (tertiary full-set FX fallback), gold-api.com, FRED DGS3MO, New York Fed EFFR, FRED DFF fallback, Treasury.gov yield curve XML fallback, the ECB Data API for 3M compounded €STR, SIX delayed SARON compound-rate downloads via public guest access, FRED and ALFRED IUDZOS2 SONIA Compounded Index mirrors with Bank of England IADB IUDZOS2 fallback (GBP SONIA Compounded Index), Bank of Japan Time-Series Data Search STRDCLUCON (JPY call-rate proxy), Banxico SIE SF43936 (MXN CETES 28d, token-gated), BCB SGS series 11 (BRL SELIC), Reserve Bank of Australia F1 money-market CSV (AUD cash-rate target), Bank of Canada Valet V122530 (CAD CORRA proxy), Central Bank of Russia DailyInfo KeyRateXML (RUB key rate), and CBRT EVDS BIST TLREF TP.BISTTLREF.ORAN (TRY overnight reference rate)",
  },
  {
    label: "Regulatory Registers",
    sources:
      "ESMA MiCA registers, EBA EMT/ART issuer and significant-token registers, national competent authority registers such as ACPR REGAFI, DNB/AFM, BaFin, MFSA, CBI, and the Bank of Lithuania where relevant, plus U.S. GENIUS Act implementation sources such as OCC bulletins, FDIC rulemaking notices, FinCEN/OFAC AML rulemaking materials, Treasury state-regime comparability materials, OCC charter/decision materials, Federal Register notices, and issuer reserve or disclosure pages",
  },
  {
    label: "DEX Data",
    sources:
      "DeFiLlama Yields & Protocols, protocol-native yield APIs and deterministic on-chain yield readers (Hashnote, Ondo, Midas NAV oracles, Re Protocol, Morpho, Pendle, Royco Dawn, Yearn Kong, Beefy, Aave V3, Compound V3, BIMA Earn, Curve scrvUSD current-rate, B.Protocol LQTY-only, Zephyr Scanner), vaults.fyi as an optional gated supplemental yield source that is disabled by default and rankable only for explicitly allowlisted vaults, Curve Finance API, The Graph, Fluid API + DexReservesResolver, Balancer API, Raydium API, Orca API, Jupiter direct-route quotes, Meteora API, Stellar Horizon classic-AMM pools, Aquarius Spiko Soroban pools, TzKT Tezos uUSD holder/reserve census, Balanced bnUSD pools on ICON, Kava x/swap native USDX pools, PancakeSwap subgraphs, SUN.io SunSwap V2 pool census plus Smart Router and pinned V2 Router proofs with TronGrid RPC state, reviewed Uniswap V3, PancakeSwap V3, and Aerodrome Slipstream QuoterV2/factory RPC reads, Aerodrome and Velodrome Sugar view contracts, GeckoTerminal, DexScreener; dead or deprecated DEX slugs such as Bunni are blocked from runtime pricing and liquidity inputs rather than treated as live venues",
  },
  { label: "AI Generation", sources: "Anthropic Claude (daily digest and Monday weekly recap)" },
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
      "Staggered 5-minute, 15-minute, 30-minute, hourly, multi-hour, daily, and monthly lanes normalize the data, preserve independent protocol evidence in DEX price challenges, and cache the results for the public API.",
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
      "A 30-minute ecosystem health score that combines active-depeg severity, market-cap breadth, DEWS stress breadth, and 7-day market-cap trend across core stablecoins and cash equivalents, without double-counting tracked variants.",
    icon: Gauge,
    href: "/stability-index/",
    linkLabel: "Open stability index",
  },
  {
    title: "Safety Grades",
    description:
      "Composite A+ to F grades built from V9 Backing Quality, Exit Strength, and Economic Control, followed by peg, deployment, and binding-cap adjustments.",
    icon: FlaskConical,
    href: "/safety-scores/",
    linkLabel: "Open scorecards",
  },
  {
    title: "Contagion Map",
    description:
      "A live dependency graph showing how collateral relationships can transmit stress through the ecosystem.",
    icon: Network,
    href: "/dependency-map/",
    linkLabel: "Open dependency map",
  },
  {
    title: "Systemic Risk Scoreboard",
    description:
      "The highest-impact single-coin failure scenarios (part of Safety Scores), surfaced inside the scorecard stress panel before a crisis makes them obvious.",
    icon: Layers,
    href: "/safety-scores/",
    linkLabel: "Open stress panel",
  },
  {
    title: "Depeg Early Warning (DEWS)",
    description:
      "A per-coin stress score refreshed every 30 minutes from supply velocity, pool balance drift, liquidity erosion, price confidence, source divergence, blacklist activity, mint and burn flow, and yield anomalies.",
    icon: ShieldAlert,
    href: "/depeg/",
  },
  {
    title: "Stablecoin Comparison",
    description:
      "Side-by-side analysis of any tracked stablecoins across safety, liquidity, peg stability, and yield metrics.",
    icon: ArrowLeftRight,
    href: "/compare/",
  },
  {
    title: "Risk-Adjusted Yield",
    description:
      "Yield opportunities scored against stablecoin safety, benchmark context, source freshness, and APY consistency.",
    icon: TrendingUp,
    href: "/yield/",
  },
];

export const COMPANION_FEATURES: readonly AboutFeatureItem[] = [
  {
    title: "PharosVille",
    description:
      "A pixel-art harbor view of the same data. Every coin sails as a ship; DEWS zones become anchorages, breakwaters, and warning shoals — the classification you read in tables, drawn as a place. Best on desktop.",
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
      title: `${activeStablecoins} core stable assets`,
      description:
        "Core stablecoins and cash equivalents across supported chains, with variants classified and browsable separately.",
      icon: BarChart3,
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
      description:
        "Algorithmic failures, rug pulls, regulatory shutdowns, and the quiet abandonments worth remembering.",
      icon: Skull,
      href: "/cemetery/",
      linkLabel: "Open cemetery",
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
      title: "Bluechip safety ratings",
      description:
        "Independent SMIDGE (Security, Management, Insurance, Decentralization, Governance, Escrow) coverage for rated stablecoins, pulled in as an outside reference signal.",
      icon: ShieldCheck,
      href: "https://bluechip.org",
      external: true,
      linkLabel: "Review source",
    },
    {
      title: "DEX liquidity",
      description: "Pool depth, volume, quality-adjusted TVL, durability, and pair diversity scored 0-100.",
      icon: Droplets,
      href: "/liquidity/",
      linkLabel: "Open liquidity tracker",
    },
    {
      title: "Chain Analytics",
      description:
        "Per-chain stablecoin supply totals, 24h/7d/30d trends, composition breakdowns, and a Chain Health Score across quality, chain environment, concentration, peg stability, and backing diversity.",
      icon: Globe,
      href: "/chains/",
      linkLabel: "Open chain leaderboard",
    },
    {
      title: "Mint and burn flows",
      description:
        "Configured issuance-chain mint and burn monitoring via Alchemy JSON-RPC, including the Bank Run Gauge and flight-to-quality detection.",
      icon: Flame,
      href: "/flows/",
      linkLabel: "Open flow tracker",
    },
    {
      title: "Portfolio Audit",
      description:
        "Analyze your stablecoin holdings against Pharos safety, liquidity, and peg data to spot concentration risk.",
      icon: Briefcase,
      href: "/portfolio/",
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
      answer: `Pharos uses ${activeStablecoins} core stablecoins and cash equivalents for ecosystem market aggregates, while keeping tracked variants and stable-value investments visible as separate listing classes. It documents ${deadStablecoins} dead stablecoins in the cemetery, monitors issuer freeze and blacklist events on-chain, provides peg scores and depeg heatmaps, scores DEX liquidity, computes a 30-minute Pharos Stability Index, and publishes risk report cards.`,
    },
    {
      question: "How does Pharos classify stablecoins?",
      answer:
        "Pharos classifies stablecoins into three governance tiers: CeFi (fully centralized), CeFi-Dependent (decentralized infrastructure but reliant on centralized collateral or peg mechanisms), and DeFi (fully on-chain, no centralized custody dependency). This reflects actual infrastructure dependency, not marketing claims.",
    },
    {
      question: "Where does Pharos get its data?",
      answer:
        "Pharos aggregates data from DefiLlama, CoinGecko, on-chain RPC nodes, Etherscan, TronGrid, protocol-native APIs, public regulatory registers, and curated sources like Bluechip. Details on all data sources are available on the About page.",
    },
  ];
}
