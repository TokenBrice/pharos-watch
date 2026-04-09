import type { Metadata } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Droplets,
  ExternalLink,
  Flame,
  FlaskConical,
  Gauge,
  GitBranch,
  Globe,
  Layers,
  Network,
  Newspaper,
  Radio,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Skull,
  type LucideIcon,
} from "lucide-react";
import { AboutReferenceModule } from "@/components/about-reference-module";
import { Button } from "@/components/ui/button";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { safeJsonLd } from "@/lib/json-ld";
import { buildFaqJsonLd } from "@/lib/faq";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { ACTIVE_STABLECOINS, PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";

const DATA_SOURCE_GROUPS = [
  {
    label: "Supply & Price",
    sources:
      "DefiLlama, CoinGecko, GeckoTerminal, CoinMarketCap, DexScreener, Jupiter Price API, Pyth Network, Binance, Kraken, Bitstamp, Coinbase, RedStone, Curve on-chain, Fluid, Balancer, Raydium, Orca, Meteora, PancakeSwap, Aerodrome Slipstream, Velodrome Slipstream, and direct protocol redemption quotes for selected redeemable assets such as Cap cUSD and infiniFi iUSD; CoinGecko also repairs total supply for tracked DefiLlama-backed assets when known deployments are missing from DefiLlama chain coverage",
  },
  {
    label: "Reserve Transparency",
    sources:
      "Issuer and protocol reserve APIs, dashboards, proof-of-reserve portals, and direct on-chain vault/accounting reads (including live reserve composition feeds from providers such as Anzen, Ethena, Falcon, Frankencoin, infiniFi, M0, Mento Reserve, OpenEden, Re, USDD, USD.AI, Accountable, Tether, Frax, Circle, First Digital Labs, SG-FORGE, Paxos, Sky/MakerDAO, Chainlink PoR/NAV oracles, Aave GHO, and Curve/Yield Basis reserve reads where available)",
  },
  {
    label: "On-chain Reads & Events",
    sources:
      "Etherscan v2 (freeze events), TronGrid, Alchemy, dRPC, selected public chain RPCs (including EVM RPCs for Ethereum mint/burn flows, direct Liquity/B.Protocol reads, and Frankencoin's ZCHF -> VCHF StablecoinBridge balance probe, plus Solana mainnet RPC reads for tracked mint-supply validation), and reconciled freeze-ledger bootstrap rows from kyc.rip / stables.rip for major ETH and TRON blacklist coverage",
  },
  {
    label: "Ratings & Reference",
    sources:
      "Bluechip, Chainlink Data Feeds, ECB via Frankfurter, Open Exchange Rates (real-time FX cross-validation), fawazahmed0/currency-api (CNH and non-ECB FX), ExchangeRate-API (tertiary full-set FX fallback), gold-api.com, FRED DGS3MO, the ECB Data API for 3M compounded €STR, and SIX delayed SARON compound-rate downloads via public guest access",
  },
  {
    label: "DEX Data",
    sources:
      "DeFiLlama Yields & Protocols, protocol-native yield APIs (Hashnote, Ondo, Morpho, Pendle, Yearn Kong, Beefy, Aave V3, Compound V3, BIMA Earn), Curve Finance API, The Graph, Fluid API + DexReservesResolver, Balancer API, Raydium API, Orca API, Meteora API, PancakeSwap subgraphs, Aerodrome and Velodrome Sugar view contracts, GeckoTerminal, DexScreener; dead or deprecated DEX slugs such as Bunni are blocked from runtime pricing and liquidity inputs rather than treated as live venues",
  },
  { label: "AI Generation", sources: "Anthropic Claude (daily digest)" },
] as const;

const INLINE_EXTERNAL_LINK_CLASS =
  "pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-foreground underline underline-offset-4 transition-colors hover:text-frost-blue";
const CTA_BUTTON_CLASS =
  "min-h-11 w-full justify-between rounded-2xl border-border/65 bg-background/50 px-4 py-2 whitespace-normal text-left sm:h-9 sm:min-h-0 sm:w-auto sm:justify-center sm:whitespace-nowrap sm:rounded-full";

type AboutTone = "brand" | "data" | "insight" | "classification" | "neutral";

interface AboutFeatureItem {
  title: string;
  description: ReactNode;
  icon: LucideIcon;
  href?: string;
  external?: boolean;
  linkLabel?: string;
}

function getToneClasses(tone: AboutTone) {
  switch (tone) {
    case "brand":
      return {
        border: "border-l-frost-blue",
        kicker: "text-sky-700 dark:text-frost-blue/82",
        icon: "text-sky-700 dark:text-frost-blue/82",
        rule: "from-frost-blue/35 to-transparent",
      };
    case "data":
      return {
        border: "border-l-amber-500",
        kicker: "text-amber-700 dark:text-amber-400",
        icon: "text-amber-700 dark:text-amber-400",
        rule: "from-amber-500/35 to-transparent",
      };
    case "insight":
      return {
        border: "border-l-emerald-500",
        kicker: "text-emerald-700 dark:text-emerald-400",
        icon: "text-emerald-700 dark:text-emerald-400",
        rule: "from-emerald-500/35 to-transparent",
      };
    case "classification":
      return {
        border: "border-l-violet-500",
        kicker: "text-violet-700 dark:text-violet-400",
        icon: "text-violet-700 dark:text-violet-400",
        rule: "from-violet-500/35 to-transparent",
      };
    default:
      return {
        border: "border-l-zinc-500",
        kicker: "text-muted-foreground",
        icon: "text-muted-foreground",
        rule: "from-border to-transparent",
      };
  }
}

function PipelineSources() {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
      {DATA_SOURCE_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1">
          <dt className="pharos-kicker">{group.label}</dt>
          <dd className="text-xs leading-relaxed text-muted-foreground">{group.sources}</dd>
        </div>
      ))}
    </dl>
  );
}

function AboutFeatureRow({ item, tone }: { item: AboutFeatureItem; tone: AboutTone }) {
  const toneClasses = getToneClasses(tone);
  const rowClassName = cn(
    "flex min-h-11 gap-3 rounded-xl px-2 py-4 sm:px-3",
    item.href && "pharos-focus-ring pharos-interactive-card group hover:bg-muted/20",
  );

  const content = (
    <>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/75">
        <item.icon className={cn("h-4 w-4", toneClasses.icon)} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{item.title}</h3>
        <div className="text-sm leading-relaxed text-muted-foreground">{item.description}</div>
        {item.href ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground">
            {item.linkLabel ?? (item.external ? "Open source" : "Open route")}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        ) : null}
      </div>
    </>
  );

  if (!item.href) {
    return <article className={rowClassName}>{content}</article>;
  }

  if (item.external) {
    return (
      <a href={item.href} target="_blank" rel="noopener noreferrer" className={rowClassName}>
        {content}
      </a>
    );
  }

  return (
    <Link href={item.href} className={rowClassName}>
      {content}
    </Link>
  );
}

function AboutSection({
  eyebrow,
  title,
  tone,
  children,
  contentClassName,
}: {
  eyebrow: string;
  title: string;
  tone: AboutTone;
  children: ReactNode;
  contentClassName?: string;
}) {
  const toneClasses = getToneClasses(tone);

  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneClasses.border)}>
      <CardHeader className="space-y-2">
        <div className="flex items-center gap-3">
          <p className={cn("pharos-kicker", toneClasses.kicker)}>{eyebrow}</p>
          <div className={cn("h-px flex-1 bg-gradient-to-r", toneClasses.rule)} />
        </div>
        <CardTitle as="h2">{title}</CardTitle>
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}

function AboutFeatureSection({
  eyebrow,
  title,
  intro,
  items,
  tone,
  footer,
}: {
  eyebrow: string;
  title: string;
  intro: ReactNode;
  items: readonly AboutFeatureItem[];
  tone: AboutTone;
  footer?: ReactNode;
}) {
  return (
    <AboutSection eyebrow={eyebrow} title={title} tone={tone} contentClassName="space-y-0">
      <div className="-mt-2 mb-4 max-w-3xl px-4 text-sm leading-relaxed text-muted-foreground">{intro}</div>
      <div className="divide-y divide-border/60">
        {items.map((item) => (
          <AboutFeatureRow key={item.title} item={item} tone={tone} />
        ))}
      </div>
      {footer ? <div className="mt-4 border-t border-border/60 pt-4">{footer}</div> : null}
    </AboutSection>
  );
}

export const metadata: Metadata = {
  title: "About Pharos: Shining a Light on Every Peg",
  description:
    "About Pharos, an open stablecoin analytics dashboard by TokenBrice, Ike, Claude, and Codex. Honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
  alternates: {
    canonical: "/about/",
  },
  openGraph: {
    title: "About Pharos: Shining a Light on Every Peg",
    description:
      "About Pharos, an open stablecoin analytics dashboard by TokenBrice, Ike, Claude, and Codex. Honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
    url: "/about/",
    type: "website",
    images: [{ url: "/og-card.png", width: 1200, height: 628 }],
  },
};

export default function AboutPage() {
  const trackedFeatures: AboutFeatureItem[] = [
    {
      title: `${ACTIVE_STABLECOINS.length} stablecoins`,
      description: "Coverage across every major chain, classified by governance, backing, and peg currency.",
      icon: BarChart3,
    },
    {
      title: `${PRE_LAUNCH_STABLECOINS.length} upcoming stablecoins`,
      description:
        "Pre-launch projects tracked from announcement to launch, with milestones, timelines, and featured content.",
      icon: Rocket,
      href: "/upcoming/",
      linkLabel: "View upcoming",
    },
    {
      title: `${DEAD_STABLECOINS.length} coins in the Cemetery`,
      description:
        "Algorithmic failures, rug pulls, regulatory shutdowns, and the quiet abandonments worth remembering.",
      icon: Skull,
      href: "/cemetery/",
      linkLabel: "Open cemetery",
    },
    {
      title: "Blacklist Tracker",
      description:
        "USDC, USDT, PAXG, XAUT, PYUSD, and USD1 blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron, with a reconciled freeze ledger for major ETH and TRON blacklist totals.",
      icon: ShieldAlert,
      href: "/blacklist/",
      linkLabel: "Open blacklist tracker",
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
      description: "Independent SMIDGE coverage for rated stablecoins, pulled in as an outside reference signal.",
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
        "Ethereum mint and burn monitoring via Alchemy JSON-RPC, including the Bank Run Gauge and flight-to-quality detection.",
      icon: Flame,
      href: "/flows/",
      linkLabel: "Open flow tracker",
    },
  ];

  const computedFeatures: AboutFeatureItem[] = [
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
        "A 30-minute ecosystem health score that combines active-depeg severity, market-cap breadth, DEWS stress breadth, and 7-day market-cap trend into a 0-100 signal.",
      icon: Gauge,
      href: "/stability-index/",
      linkLabel: "Open stability index",
    },
    {
      title: "Safety Grades",
      description:
        "Composite A+ to F grades built from liquidity, resilience, decentralization, dependency risk, and peg behavior.",
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
        "The highest-impact single-coin failure scenarios, surfaced inside the scorecard stress panel before a crisis makes them obvious.",
      icon: Layers,
      href: "/safety-scores/",
      linkLabel: "Open stress panel",
    },
    {
      title: "Depeg Early Warning (DEWS)",
      description:
        "A per-coin stress score refreshed every 30 minutes from supply velocity, pool balance drift, liquidity erosion, price confidence, source divergence, blacklist activity, mint and burn flow, and yield anomalies.",
      icon: ShieldAlert,
    },
  ];

  return (
    <FeaturePageShell
      breadcrumbName="About Pharos"
      path="/about/"
      title="About Pharos"
      leadParagraphs={[
        "A practitioner-built watchtower for stablecoins: market structure, peg stress, liquidity, dependency risk, and the failures everyone else stops tracking.",
      ]}
      headerSupplement={<AboutReferenceModule />}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd(
              buildFaqJsonLd([
                {
                  question: "Why does Pharos exist?",
                  answer:
                    "Pharos is a project by TokenBrice, Ike, Claude, and Codex. It puts the stablecoin data you want to monitor in one place: honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
                },
                {
                  question: "What does Pharos track?",
                  answer: `Pharos tracks ${ACTIVE_STABLECOINS.length} stablecoins across every major chain, classified by governance, backing, and peg currency. It documents ${DEAD_STABLECOINS.length} dead stablecoins in the cemetery, monitors USDC, USDT, PAXG, XAUT, PYUSD, and USD1 freeze and blacklist events on-chain, provides composite peg scores with depeg detection and heatmaps, integrates independent Bluechip SMIDGE safety ratings, scores DEX liquidity depth 0–100 across decentralized exchanges, computes a 30-minute Pharos Stability Index for ecosystem health, and issues report cards grading each stablecoin across 5 dimensions, including an exit-liquidity dimension that now blends DEX liquidity with protocol or issuer redemption backstops when a direct exit path exists.`,
                },
                {
                  question: "How does Pharos classify stablecoins?",
                  answer:
                    "Pharos classifies stablecoins into three governance tiers: CeFi (fully centralized), CeFi-Dependent (decentralized infrastructure but reliant on centralized collateral or peg mechanisms), and DeFi (fully on-chain, no centralized custody dependency). This reflects actual infrastructure dependency, not marketing claims.",
                },
                {
                  question: "Where does Pharos get its data?",
                  answer:
                    "All data is fetched server-side by a Cloudflare Worker and cached in D1. Sources include DefiLlama for supply, price, and chain distribution, with CoinGecko repairing total supply when a tracked DefiLlama-backed asset is missing known deployments from DefiLlama chain coverage; CoinGecko also provides logos and fallback prices; CoinMarketCap and DexScreener act as further price fallbacks; direct protocol redemption quotes are used for selected redeemable assets such as Cap cUSD and infiniFi iUSD; issuer and protocol reserve APIs, dashboards, proof-of-reserve portals, and direct on-chain vault/accounting reads provide live reserve composition and redemption-backstop capacity where available, including Anzen, Ethena, Falcon, Frankencoin, infiniFi, M0, Mento Reserve, OpenEden, Re, USDD, Accountable, Tether, Frax, Circle, First Digital Labs, SG-FORGE, Paxos, Sky/MakerDAO, Chainlink PoR/NAV oracles, Aave GHO reserve feeds, and direct Curve/Yield Basis reserve reads for crvUSD; Etherscan v2 and TronGrid provide freeze-event tracking, with reconciled freeze-ledger bootstrap rows from kyc.rip / stables.rip for major ETH and TRON blacklist totals; Alchemy, dRPC, and selected public chain RPCs cover EVM reads including Ethereum mint/burn flow tracking and direct contract calls such as Cap and infiniFi redemption quotes, Frankencoin's ZCHF -> VCHF StablecoinBridge balance probe, Liquity/B.Protocol, ERC-4626 vault reads, Fluid DexReservesResolver reads, and Aerodrome/Velodrome Sugar view reads, while Solana mainnet RPC covers tracked mint-supply validation for live reserve feeds on Solana-issued assets; Bluechip provides safety ratings; ECB via Frankfurter plus fawazahmed0/currency-api provide live FX rates including CNH and other non-ECB coverage, with ExchangeRate-API as a tertiary full-set FX fallback; gold-api.com provides gold and silver spot prices; FRED DGS3MO, the ECB Data API for 3M compounded €STR, and SIX delayed SARON compound-rate downloads provide benchmark rates; DeFiLlama Yields &amp; Protocols, Curve Finance API, The Graph, Fluid API + DexReservesResolver, Balancer API, Raydium API, Orca API, Meteora API, PancakeSwap subgraphs, Aerodrome and Velodrome Sugar view contracts, and GeckoTerminal provide DEX liquidity data, while dead or deprecated venues such as Bunni are explicitly blocked from runtime pricing and liquidity inputs; and Anthropic Claude generates the daily digest.",
                },
              ]),
            ),
          }}
        />
      }
    >
      <div className="space-y-8">
        <AboutSection
          eyebrow="Why it exists"
          title="Why Pharos?"
          tone="brand"
          contentClassName="space-y-3 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Stablecoins are the backbone of on-chain finance, yet the data to evaluate them is scattered, inconsistent,
            or buried behind paywalls. Pharos changes that. It tracks {ACTIVE_STABLECOINS.length} live stablecoins,{" "}
            {PRE_LAUNCH_STABLECOINS.length} upcoming launches, and {DEAD_STABLECOINS.length} dead ones across every
            major chain, scoring each on peg integrity, liquidity depth, resilience, and contagion risk. Real-time depeg
            detection, freeze monitoring, safety grades, mint-and-burn flow analysis, and a 30-minute ecosystem-wide
            stability index give you the full picture before a crisis makes the headlines. You can also plug in your own
            holdings to see your effective stablecoin exposure, concentration risks, and blended safety profile in one
            view.
          </p>
          <p>
            Pharos is a public good, a resource. It&apos;s a mission-driven project made to elevate the understanding of
            stablecoin market participants: free, open source, and with no plan to monetize. Make the most of it!
          </p>
        </AboutSection>

        <AboutSection
          eyebrow="The team"
          title="Who Is Building Pharos?"
          tone="brand"
          contentClassName="grid gap-4 text-sm leading-relaxed text-muted-foreground lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-5"
        >
          <div className="flex flex-wrap items-start gap-4">
            <figure className="flex flex-col items-center gap-1.5">
              <div className="rounded-xl border border-border/60 bg-background/50 p-1">
                <Image
                  src="/tokenbrice.png"
                  alt="TokenBrice"
                  width={72}
                  height={72}
                  className="h-14 w-14 rounded-lg sm:h-16 sm:w-16"
                />
              </div>
              <figcaption className="text-[11px] uppercase tracking-wide text-muted-foreground">Creator</figcaption>
            </figure>
            <figure className="flex flex-col items-center gap-1.5">
              <div className="rounded-xl border border-border/60 bg-background/50 p-1">
                <Image
                  src="/ike.jpg"
                  alt="Ike"
                  width={72}
                  height={72}
                  className="h-14 w-14 rounded-lg sm:h-16 sm:w-16"
                />
              </div>
              <figcaption className="text-[11px] uppercase tracking-wide text-muted-foreground">Champion</figcaption>
            </figure>
            <figure className="flex flex-col items-center gap-1.5">
              <div className="rounded-xl border border-border/60 bg-background/50 p-1">
                <Image
                  src="/claude.png"
                  alt="Claude"
                  width={72}
                  height={72}
                  className="h-14 w-14 rounded-lg sm:h-16 sm:w-16"
                />
              </div>
              <figcaption className="text-[11px] uppercase tracking-wide text-muted-foreground">
                AI Brainstormer
              </figcaption>
            </figure>
            <figure className="flex flex-col items-center gap-1.5">
              <div className="rounded-xl border border-border/60 bg-background/50 p-1">
                <Image
                  src="/codex.svg"
                  alt="Codex"
                  width={72}
                  height={72}
                  className="h-14 w-14 rounded-lg sm:h-16 sm:w-16"
                />
              </div>
              <figcaption className="text-[11px] uppercase tracking-wide text-muted-foreground">AI Engineer</figcaption>
            </figure>
          </div>
          <div className="space-y-3">
            <p>
              <a
                href="https://tokenbrice.xyz/"
                target="_blank"
                rel="noopener noreferrer"
                className={INLINE_EXTERNAL_LINK_CLASS}
              >
                TokenBrice
                <ExternalLink className="h-3.5 w-3.5" />
              </a>{" "}
              created Pharos and leads product direction, scoring methodology, and the data pipeline.{" "}
              <a
                href="https://x.com/Ikebillion_"
                target="_blank"
                rel="noopener noreferrer"
                className={INLINE_EXTERNAL_LINK_CLASS}
              >
                Ike
                <ExternalLink className="h-3.5 w-3.5" />
              </a>{" "}
              drives growth and communications, getting Pharos in front of the people who need it. The engineering is
              AI-native: most of the codebase is written and maintained by{" "}
              <a
                href="https://www.anthropic.com/claude-code"
                target="_blank"
                rel="noopener noreferrer"
                className={INLINE_EXTERNAL_LINK_CLASS}
              >
                Claude
                <ExternalLink className="h-3.5 w-3.5" />
              </a>{" "}
              and{" "}
              <a
                href="https://openai.com/codex/"
                target="_blank"
                rel="noopener noreferrer"
                className={INLINE_EXTERNAL_LINK_CLASS}
              >
                Codex
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              , from the worker pipeline and scoring engine to the frontend and daily digest.
            </p>
          </div>
        </AboutSection>

        <AboutFeatureSection
          eyebrow="Coverage"
          title="What Pharos Tracks"
          intro="The raw monitoring layer: live supply, peg behavior, blacklist activity, liquidity depth, and chain-level flow data pulled into one operating picture."
          items={trackedFeatures}
          tone="data"
        />

        <AboutFeatureSection
          eyebrow="Signals"
          title="What Pharos Computes"
          intro="The analysis layer: digest summaries, ecosystem health scoring, dependency spillovers, safety grades, and forward-looking depeg pressure."
          items={computedFeatures}
          tone="insight"
          footer={
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Telegram alerts cover DEWS state changes, depeg events, and safety grade changes.
              </p>
              <Button asChild variant="default" className={CTA_BUTTON_CLASS}>
                <Link href="/telegram/">
                  Open @PharosWatchBot
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          }
        />

        <AboutSection
          eyebrow="In the wild"
          title="Live Walkthrough"
          tone="brand"
          contentClassName="flex flex-col gap-4 text-sm leading-relaxed text-muted-foreground sm:flex-row sm:items-start"
        >
          <Radio className={cn("mt-0.5 h-5 w-5 shrink-0", getToneClasses("brand").icon)} />
          <div className="space-y-3">
            <p>
              TokenBrice walked through Pharos live on Leviathan News, covering the motivation behind the project, how
              the data pipeline works, and how the main risk signals should be read in practice.
            </p>
            <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
              <a href="https://x.com/i/broadcasts/1qxvvkeMlyAxB" target="_blank" rel="noopener noreferrer">
                Watch the Leviathan News broadcast
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </AboutSection>

        <AboutSection
          eyebrow="Governance lens"
          title="Classification"
          tone="classification"
          contentClassName="text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Pharos classifies stablecoins into three governance tiers:{" "}
            <span className="font-medium text-foreground">CeFi</span> (fully centralized),{" "}
            <span className="font-medium text-foreground">CeFi-Dependent</span> (decentralized infrastructure but
            reliant on centralized collateral or peg mechanisms), and{" "}
            <span className="font-medium text-foreground">DeFi</span> (fully on-chain, no centralized custody
            dependency). The classification reflects actual infrastructure dependency, not marketing claims.
          </p>
        </AboutSection>

        <AboutSection
          eyebrow="Source flow"
          title="Data Pipeline"
          tone="data"
          contentClassName="space-y-5 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            All data is fetched server-side by a Cloudflare Worker and cached in D1. The browser never calls external
            APIs directly.
          </p>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.95fr)]">
            <div className="rounded-xl bg-muted/20 p-4 space-y-4">
              <p className="text-sm font-semibold text-foreground">Source groups</p>
              <PipelineSources />
            </div>
            <div className="rounded-xl bg-muted/20 p-4 space-y-4 lg:border-l-2 lg:border-border/60 lg:bg-transparent lg:p-0 lg:border-l">
              <p className="text-sm font-semibold text-foreground">Processing path</p>
              <ol className="space-y-4">
                <li aria-label="Step 1: Sources" className="flex gap-3">
                  <div
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/70 text-sm font-semibold text-foreground"
                  >
                    1
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Sources</p>
                    <p>
                      Market, on-chain, ratings, FX, commodity, and digest inputs are collected on a fixed schedule.
                    </p>
                  </div>
                </li>
                <li aria-label="Step 2: Cloudflare Worker + D1" className="flex gap-3">
                  <div
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/70 text-sm font-semibold text-foreground"
                  >
                    2
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Cloudflare Worker + D1</p>
                    <p>
                      Staggered quarter-hourly, half-hourly, hourly, and daily cron jobs normalize the data and cache
                      the results for the public API.
                    </p>
                  </div>
                </li>
                <li aria-label="Step 3: Static dashboard" className="flex gap-3">
                  <div
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/70 text-sm font-semibold text-foreground"
                  >
                    3
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Static dashboard</p>
                    <p>
                      Next.js pages on Cloudflare Pages consume the worker outputs and render the stablecoin view
                      without direct third-party calls.
                    </p>
                  </div>
                </li>
              </ol>
            </div>
          </div>
        </AboutSection>

        <AboutSection
          eyebrow="Scoring details"
          title="Methodology"
          tone="data"
          contentClassName="space-y-3 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Pharos grades every stablecoin across four base dimensions, with peg stability acting as a multiplier on
            top. The methodology page covers the full grading formula, peg score computation, DEX liquidity scoring, and
            contagion stress-test design.
          </p>
          <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
            <Link href="/methodology/">
              Read the full methodology
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </AboutSection>

        <aside className="border-y border-border/60 py-5 text-xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">Disclaimer</span> — Pharos is an informational tool, not a
            licensed financial advisor. Nothing on this site constitutes financial, investment, or legal advice. All
            data is provided as-is and may contain errors or delays. Always do your own research and consult a qualified
            professional before making financial decisions.
          </p>
        </aside>

        <AboutSection
          eyebrow="Reach out"
          title="Get in Touch"
          tone="brand"
          contentClassName="space-y-3 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Pharos is fully open source. If you spot a bad data point, want a stablecoin added, or want to understand
            how something is computed, open the code or reach out directly.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
              <a href="https://github.com/TokenBrice/stablecoin-dashboard" target="_blank" rel="noopener noreferrer">
                <GitBranch className="h-4 w-4" />
                View on GitHub
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
            <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
              <a href="https://x.com/PharosWatch" target="_blank" rel="noopener noreferrer">
                @PharosWatch
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
            <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
              <a href="https://tokenbrice.xyz/" target="_blank" rel="noopener noreferrer">
                tokenbrice.xyz
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </AboutSection>
      </div>
    </FeaturePageShell>
  );
}
