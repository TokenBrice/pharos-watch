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
  ShieldCheck,
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
    `Live reserve feeds, forward-looking depeg warnings, and public blacklist monitoring across a ${activeStablecoins}-asset core universe of stablecoins and cash equivalents: everything that could make a stable asset fail.`,
  ];
}

export const DATA_SOURCE_GROUPS = [
  {
    label: "Supply & Price",
    sources:
      "DefiLlama, CoinGecko, GeckoTerminal, CoinMarketCap, DexScreener, DexPaprika, Alchemy Prices API, Moralis Token Prices, Birdeye, Jupiter Price API, Binance, Kraken, Bitstamp, Coinbase, RedStone, Kava Pricefeed, Curve on-chain, Chainlink NAV reserve telemetry, Superstate NAV/liquidity telemetry, JPMorgan exact-class money-market NAV telemetry (JLTXX remains quarantined; staged bootstrap evidence is not price/market-cap admission), Flying Tulip's on-chain ftUSD reserve index, Fluid, Balancer, Curve, Uniswap V3 (including guarded USDU/USDT QuoterV2 sell quotes), Uniswap V4, Raydium, Orca, Meteora, PancakeSwap, Aerodrome, Velodrome, guarded Mento FPMM and Broker quotes, exact Aerodrome BD/USDC sell quotes, reviewed Jupiter USDv/USDC direct-route quotes with independent Solana pool-state checks, dEURO EURC StablecoinBridge redemption, Citrea StablecoinBridge, Zephyr Scanner, Movement REST, direct protocol redemption or FX-par quotes, curated fail-closed on-chain supply-gap repairs, and V10 lockbox attribution reads. Exchange spot prices remain. CoinGecko discovery tickers supply price/observed-flow evidence only, weighted by flow and confidence with zero liquidity TVL; synthetic orderbook pools no longer count. Direct Binance/Coinbase/Kraken depth diagnostics and the dormant exact Kraken observer are retired, not scoring or settlement evidence",
  },
  {
    label: "Reserve Transparency",
    sources:
      "Issuer and protocol reserve APIs, dashboards, proof-of-reserve portals, issuer attestation indexes, and direct on-chain vault/accounting reads (including Ethena collateralization and proof-of-reserves measurements, plus reserve composition disclosures and scoped feeds from providers such as 3Jane, Anzen, Chronicle Proof of Asset, Falcon, Frankencoin, Hashnote, infiniFi, M0, Makina strategy/allocation APIs with identity-verified on-chain Machine AUM reconciliation, Mento Reserve / analytics API, OpenEden cUSDO (TBILL's separate configuration is retained but quarantined, not an active feed), Origin OUSD vault/redemption, Blast, Nest Credit (positions and corroborated gross/net NAV), Re, Resupply, Reserve Protocol, USDD, USD.AI, USD1 Chainlink bundle oracle, Backed (public assetReserves circulation feed), Accountable, LedgerLens / Wyoming FRNT, Coinbase ONED proof-of-reserves GraphQL, BlackRock BRSRV holdings CSV, Universal USDU, Supercoin ZARSC, Secured Finance USDFC, Somnia BrandedCustodian, Hyperbeat, Tether, Frax, Circle, First Digital Labs, Ripple/Deloitte reserve examinations, Ondo OUSG portfolio disclosures, Midas mTBILL position disclosures, J.P. Morgan Asset Management's exact Token Class NAV and class-assets publisher (issuer-reported valuation, not independent portfolio assurance; JLTXX stays quarantined), Macropod issuer-signed reserve verification (issuer self-verification, not independent assurance), Solomon Labs token-backing API (selected Chancery reserve accounts for replacement USDv only; issuer-reported, not live RPC, a whole book or supply/redemption coverage), SG-FORGE, Paxos/KPMG reserve examinations, Money on Chain DOC accounting reads, Aura Partners, KPMG/SALVUS (Schuman Financial), Sky/MakerDAO, Chainlink PoR/NAV oracles, StraitsX / KK Yap & Associates, Kinesis, Quantoz, Yamato, Aave GHO, BIMA reserve telemetry, SMARDEX, f(x), Asymmetry, JupUSD, Morpho vault liquidity, USDGO, Yield Optimizer, Yuzu, Solstice, River, Alloy, Zephyr Scanner, Spiko, United Stables, Polymarket PUSD vault reads, Gnosis xDAI bridge collateral reads, Hive consensus-state reads, LeverUp LVUSD Monad vault census reads, Blox MYRC hash-pinned independent examination reports, Spark V1 local receipt inventory, Forest Road manager accounting reconciliation, and Curve/Yield Basis reserve reads where available; receipt/accounting measurements do not by themselves establish executable redemption liquidity). Single-asset v2 reports native CAD/QCAD and GBP/tGBP quantities on reviewed nominal bases, never USD; an Ethereum supply clock is diagnostic, not whole-reserve freshness, and reserve snapshots do not invent redemption terms or capacity. The six raw Chainlink PoR v3 bindings are BC3M, BIB01, GLDY, KAG, KAU and TUSD, preserving exact deployment inventories, original feed/supply clocks and typed unavailable reasons; BC3M uses a reviewed inclusive 86,400-second reserve/supply skew allowance after complete exact circulation reconciliation, while BIB01's unreviewed temporal policy withholds ratios. Separate Chainlink NAV sources are not part of that six-binding inventory. ZARP, Ripio wFIAT, USDU and ZARSC report indexes validate report identity/date while allocations remain reviewed static composition, not observed redemption. AUDD's agreed-upon-procedures report provides no assurance opinion; BRLV/AUDM are issuer-attested. Zephyr, AFI, ONED and BRSRV are limited issuer/protocol/disclosed-securities telemetry, not independently complete legal reserve books; static/weak sources remain detail/status evidence outside independent scoring admission. Solstice totals/proof strings are not a verifier or assurance stream; River's protocol-TVL quotient is not satUSD backing (genuine exit routes remain). DGLD adverse arithmetic stays degraded; XAGm retains original issuer-round age and its 60-day cap. ONRE's three reconciliation guards alone do not establish independent book evidence; Avant gross contextual observations/nulls retain wholly unknown composition. Flying Tulip reads one first-party index with three payloads, not independent chain inventory; SODAX's local census omits ICON/Archway/Havah/Injective and supplies no global ratio; FRNT gross supplemental metrics are not a retrieved assurance report or net-payable allocation. MYRC's independent examination preserves native MYR cash/fund rows, net-liability reconciliation and the original balance date under a 33-day cap; signing/upload/access does not renew balances. USDY retains its reviewed September 3 manifest and separately October 1-reviewed September 25 allocation with manual refresh, not automatic newest-report discovery. Matrixdock STBT's reserve adapter, Origin's manual observer, Solomon legacy, USDH, Abracadabra MIM, StoneYield and OpenEden USDO runtime tails are retired; coin/curated/history evidence and replacement bindings remain",
  },
  {
    label: "On-chain Reads & Events",
    sources:
      "Etherscan v2 (freeze events), TronGrid, Alchemy, dRPC, Dwellir (supplemental last-position fallback RPC operator on 37 EVM chains, including Etherlink, Cronos, Flow EVM, PulseChain, Immutable zkEVM, Boba, Astar, and Taiko, also powering an internal provider-parity monitor; it does not replace existing providers and is not used for mint/burn or blacklist event scans), selected public chain RPCs (including MegaETH public RPC, Fraxtal public RPC for reviewed supply and lockbox attribution without changing aggregate supply, EVM RPCs for configured mint/burn flows, direct Liquity/B.Protocol branch debt reads, and Frankencoin's ZCHF -> CHFAU StablecoinBridge balance probe, plus Solana mainnet RPC reads for tracked mint-supply validation, Starknet RPC reads, Sui mainnet GraphQL reads of Ember eEARN native receipt supply, and DFINITY ICRC REST indexer reads for ICP), and reconciled freeze-ledger bootstrap rows from kyc.rip / stables.rip for major ETH and TRON blacklist coverage; Astherus asUSDF's public BSC (BNB Chain) EVM RPC with a Multicall3 aggregate3 read of the custom asUSDFEarn contract (not ERC-4626) to observe USDF backing net of unvested yield; Initia interwoven-1 LCD REST reads at /cosmos/bank/v1beta1/supply/by_denom, /initia/move/v1/view/json, and /initia/move/v1/accounts/{address}/resources/by_struct_tag to observe iUSD's AUSD0 vault backing and pin vault/metadata identities (Pharos's first Initia read path); and pinned direct route-controller/queue reads for Forest Road USDfr, Apyx apyUSD, Lido earnUSD, Monetrix USDM and Saturn sUSDat, with diagnostic versus measured capacity kept separate from reserve composition",
  },
  {
    label: "Ratings & Reference",
    sources:
      "Bluechip, eurostablecoins.xyz EUR stablecoin coverage, VNX legacy vnx.li exchange suspension and current VNXAU issuer/service notices (exact-channel evidence, not a suspension of all holder exits), L2BEAT static chain-risk and Interop snapshots for Chain Health and reviewed Safety Score bridge-route context, Chainlink Data Feeds, ECB via Frankfurter, Open Exchange Rates (real-time FX cross-validation), fawazahmed0/currency-api (CNH and non-ECB FX), ExchangeRate-API (tertiary full-set FX fallback), gold-api.com, FRED DGS3MO, New York Fed EFFR, FRED DFF fallback, Treasury.gov yield curve XML fallback, the ECB Data API for 3M compounded €STR, SIX delayed SARON compound-rate downloads via public guest access, FRED and ALFRED IUDZOS2 SONIA Compounded Index mirrors with Bank of England IADB IUDZOS2 fallback (GBP SONIA Compounded Index), Bank of Japan Time-Series Data Search STRDCLUCON (JPY call-rate proxy), Banxico SIE SF43936 (MXN CETES 28d, token-gated), BCB SGS series 11 (BRL SELIC), Reserve Bank of Australia F1 money-market CSV (AUD cash-rate target), Bank of Canada Valet V122530 (CAD CORRA proxy), Central Bank of Russia DailyInfo KeyRateXML (RUB key rate), and CBRT EVDS BIST TLREF TP.BISTTLREF.ORAN (TRY overnight reference rate)",
  },
  {
    label: "Regulatory Registers",
    sources:
      "ESMA MiCA registers, EBA EMT/ART issuer and significant-token registers, national competent authority registers such as ACPR REGAFI, DNB/AFM, BaFin, MFSA, CBI, and the Bank of Lithuania where relevant, plus U.S. GENIUS Act implementation sources such as OCC bulletins, FDIC rulemaking notices, FinCEN/OFAC AML rulemaking materials, Treasury state-regime comparability materials, OCC charter/decision materials, Federal Register notices, and issuer reserve or disclosure pages",
  },
  {
    label: "DEX Data",
    sources:
      "DeFiLlama Yields & Protocols (including exact Ethereum Uniswap V4 pool identity joins), protocol-native yield APIs and deterministic on-chain yield readers (Hashnote, Ondo, Midas NAV oracles, Re Protocol, Morpho, Pendle, Royco Dawn, Yearn Kong, Beefy, Aave V3, Compound V3, Curve scrvUSD current-rate, B.Protocol LQTY-only, Zephyr Scanner), Curve Finance API, The Graph (including live BSC recovery census and permanent execution-only input, not fee/price coverage), Fluid API + DexReservesResolver, Balancer API, Raydium API, Orca API, Jupiter direct-route quotes, Meteora API, Bluefin ordinary liquidity/discovery, Stellar Horizon classic-AMM pools, Aquarius's eight reviewed Spiko Soroban identities, TzKT Tezos uUSD holder/reserve census, Balanced bnUSD pools on ICON, Kava x/swap native USDX pools, PancakeSwap subgraphs, SUN.io SunSwap V2 pool census plus Smart Router and pinned V2 Router proofs with TronGrid RPC state, reviewed Uniswap V3, PancakeSwap V3, and Aerodrome Slipstream QuoterV2/factory RPC reads, Aerodrome and Velodrome Sugar view contracts, ordinary current/legacy Shadow Exchange venue data, GeckoTerminal, DexScreener. Listing a venue or discovery source does not activate measured routes: Ethereum alone scores hook-free V4, BSC/Base/Arbitrum/Polygon/Tempo collect shadow evidence, Unichain measurement is retired, and hooks remain unsupported negative identity/collision evidence. Hybra/XSwap exact V3, Sonic legacy and Base/Optimism volatile exact Solidly diagnostics are retired; Base/Optimism stable diagnostics remain non-scoring, without broadening classic-stable or Slipstream scoring coverage. DLMM repeated collection and Bluefin scheduled Sui selection stop, but ordinary venue sources remain; Orca/Raydium CLMM and Cetus diagnostics remain non-scoring and Raydium Standard/CPMM provider diagnostics stay shadow. Curve composite/NG preparation activates no cohort and retires none of the six retained observers; modeled DOLA/OUSD routes remain modeled and any future approved sell direction must be named exactly. vaults.fyi and dormant BIMA Earn/Etherfuse CETES yield collectors are retired, not current optional sources; Banxico's independent MXN CETES benchmark remains. Dead or deprecated DEX slugs such as Bunni are blocked from runtime pricing and liquidity inputs rather than treated as live venues",
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
      "A 30-minute ecosystem health score that combines active-depeg severity, market-cap breadth, DEWS stress breadth, and 7-day market-cap trend across core stablecoins and cash equivalents, without double-counting tracked variants.",
    icon: Gauge,
    href: "/stability-index/",
    linkLabel: "Open stability index",
  },
  {
    title: "Safety Grades",
    description:
      "Composite A+ to F grades built from V10 Backing Quality, Exit Strength, and Economic Control, followed by peg, deployment, and binding-cap adjustments.",
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
        "Independent SMIDGE (Stability, Management, Implementation, Decentralization, Governance, Externals) coverage for rated stablecoins, pulled in as an outside reference signal.",
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
