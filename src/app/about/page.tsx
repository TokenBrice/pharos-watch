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
  Github,
  Layers,
  Network,
  Newspaper,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Skull,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

const DATA_SOURCE_GROUPS = [
  { label: "Supply & Price", sources: "DefiLlama, CoinGecko, CoinMarketCap, DexScreener" },
  {
    label: "Reserve Transparency",
    sources: "Issuer and protocol reserve APIs, dashboards, and proof-of-reserve portals (including live reserve composition feeds where available)",
  },
  {
    label: "On-chain Reads & Events",
    sources:
      "Etherscan v2 (freeze events), TronGrid, Alchemy & dRPC (EVM RPCs, including Ethereum mint/burn flows and direct Liquity/B.Protocol reads)",
  },
  {
    label: "Ratings & Reference",
    sources:
      "Bluechip, ECB via Frankfurter, fawazahmed0/exchange-api (CNH and non-ECB FX), gold-api.com, FRED DGS3MO (T-bill rates)",
  },
  {
    label: "DEX Data",
    sources: "DeFiLlama Yields & Protocols, Curve Finance API, The Graph, GeckoTerminal, DexScreener",
  },
  { label: "AI Generation", sources: "Anthropic Claude (daily digest)" },
] as const;

const INLINE_EXTERNAL_LINK_CLASS =
  "pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-foreground underline underline-offset-4 transition-colors hover:text-foreground";
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
        <div key={group.label} className="space-y-1.5">
          <dt className="pharos-kicker">{group.label}</dt>
          <dd className="text-sm leading-relaxed text-foreground">{group.sources}</dd>
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
  const toneClasses = getToneClasses(tone);

  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneClasses.border)}>
      <CardHeader className="space-y-2">
        <div className="flex items-center gap-3">
          <p className={cn("pharos-kicker", toneClasses.kicker)}>{eyebrow}</p>
          <div className={cn("h-px flex-1 bg-gradient-to-r", toneClasses.rule)} />
        </div>
        <CardTitle as="h2">{title}</CardTitle>
        <div className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{intro}</div>
      </CardHeader>
      <CardContent className="space-y-0">
        <div className="divide-y divide-border/60">
          {items.map((item) => (
            <AboutFeatureRow key={item.title} item={item} tone={tone} />
          ))}
        </div>
        {footer ? <div className="mt-4 border-t border-border/60 pt-4">{footer}</div> : null}
      </CardContent>
    </Card>
  );
}

export const metadata: Metadata = {
  title: "About Pharos: Shining a Light on Every Peg",
  description:
    "About Pharos, an open stablecoin analytics dashboard by TokenBrice, Claude, and Codex. Honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
  alternates: {
    canonical: "/about/",
  },
  openGraph: {
    title: "About Pharos: Shining a Light on Every Peg",
    description:
      "About Pharos, an open stablecoin analytics dashboard by TokenBrice, Claude, and Codex. Honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
    url: "/about/",
    type: "website",
    images: [{ url: "/og-card.png", width: 1200, height: 628 }],
  },
};

export default function AboutPage() {
  const trackedFeatures: AboutFeatureItem[] = [
    {
      title: `${TRACKED_STABLECOINS.length} stablecoins`,
      description: "Coverage across every major chain, classified by governance, backing, and peg currency.",
      icon: BarChart3,
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
        "USDC, USDT, PAXG, and XAUT blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron.",
      icon: ShieldAlert,
      href: "/blacklist/",
      linkLabel: "Open blacklist tracker",
    },
    {
      title: "Peg Tracker",
      description: "Composite peg scores, depeg event detection, heatmaps, and four years of history on the dashboard.",
      icon: Activity,
      href: "/",
      linkLabel: "Open dashboard",
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
        "A daily ecosystem health score that rolls peg integrity, supply growth, and liquidity depth into a 0-100 signal.",
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
        "A per-coin stress score refreshed every 15 minutes from supply velocity, pool balance drift, liquidity erosion, price confidence, source divergence, blacklist activity, mint and burn flow, and yield anomalies.",
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
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "FAQPage",
              mainEntity: [
                {
                  "@type": "Question",
                  name: "Why does Pharos exist?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Pharos is a project by TokenBrice, Claude, and Codex. It puts the stablecoin data you want to monitor in one place: honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
                  },
                },
                {
                  "@type": "Question",
                  name: "What does Pharos track?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: `Pharos tracks ${TRACKED_STABLECOINS.length} stablecoins across every major chain, classified by governance, backing, and peg currency. It documents ${DEAD_STABLECOINS.length} dead stablecoins in the cemetery, monitors USDC/USDT/PAXG/XAUT freeze events on-chain, provides composite peg scores with depeg detection and heatmaps, integrates independent Bluechip SMIDGE safety ratings, scores DEX liquidity depth 0–100 across decentralized exchanges, computes a daily Pharos Stability Index for ecosystem health, and issues report cards grading each stablecoin across 5 risk dimensions: Peg Stability (25%), Liquidity (20%), Resilience (20%), Decentralization (15%), and Dependency Risk (25%).`,
                  },
                },
                {
                  "@type": "Question",
                  name: "How does Pharos classify stablecoins?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Pharos classifies stablecoins into three governance tiers: CeFi (fully centralized), CeFi-Dependent (decentralized infrastructure but reliant on centralized collateral or peg mechanisms), and DeFi (fully on-chain, no centralized custody dependency). This reflects actual infrastructure dependency, not marketing claims.",
                  },
                },
                {
                  "@type": "Question",
                  name: "Where does Pharos get its data?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "All data is fetched server-side by a Cloudflare Worker and cached in D1. Sources include DefiLlama for supply, price, and chain distribution; CoinGecko for logos and fallback prices; CoinMarketCap and DexScreener as further price fallbacks; issuer and protocol reserve APIs, dashboards, and proof-of-reserve portals for live reserve composition where available; Etherscan v2 and TronGrid for freeze-event tracking; Alchemy and dRPC for EVM RPCs including Ethereum mint/burn flow tracking and direct contract calls such as Liquity/B.Protocol yield reads; Bluechip for safety ratings; ECB via Frankfurter plus fawazahmed0/exchange-api for live FX rates including CNH and other non-ECB coverage; gold-api.com for gold and silver spot prices; FRED DGS3MO for T-bill rates; DeFiLlama Yields &amp; Protocols, Curve Finance API, The Graph, and GeckoTerminal for DEX liquidity data; and Anthropic Claude for daily digest generation.",
                  },
                },
              ],
            }),
          }}
        />
      }
    >
      <div className="space-y-8">
        <Card className="rounded-xl border-l-[3px] border-l-frost-blue">
          <CardHeader className="space-y-2">
            <div className="flex items-center gap-3">
              <p className="pharos-kicker text-sky-700 dark:text-frost-blue/82">Why it exists</p>
              <div className="h-px flex-1 bg-gradient-to-r from-frost-blue/35 to-transparent" />
            </div>
            <CardTitle as="h2">Why Pharos?</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm leading-relaxed text-muted-foreground lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-5">
            <div className="flex flex-wrap gap-3 lg:max-w-[18rem]">
              <Image
                src="/tokenbrice.png"
                alt="TokenBrice"
                width={80}
                height={80}
                className="h-16 w-16 rounded-xl sm:h-20 sm:w-20"
              />
              <Image
                src="/claude.png"
                alt="Claude"
                width={80}
                height={80}
                className="h-16 w-16 rounded-xl sm:h-20 sm:w-20"
              />
              <Image
                src="/codex.svg"
                alt="Codex"
                width={80}
                height={80}
                className="h-16 w-16 rounded-xl sm:h-20 sm:w-20"
              />
            </div>
            <div className="space-y-3">
              <p>
                Pharos is a project by{" "}
                <a
                  href="https://tokenbrice.xyz/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={INLINE_EXTERNAL_LINK_CLASS}
                >
                  TokenBrice
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                ,{" "}
                <a
                  href="https://www.anthropic.com/claude-code"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={INLINE_EXTERNAL_LINK_CLASS}
                >
                  Claude
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                , and{" "}
                <a
                  href="https://openai.com/codex/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={INLINE_EXTERNAL_LINK_CLASS}
                >
                  Codex
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                . It puts the stablecoin picture you actually need in one place: honest classification, peg and freeze
                tracking, liquidity depth, systemic spillovers, and a graveyard for the ones that did not make it.
              </p>
              <p>
                Development runs through{" "}
                <a
                  href="https://github.com/TokenBrice/cmcs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(INLINE_EXTERNAL_LINK_CLASS, "font-mono")}
                >
                  cmcs
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>{" "}
                and a Claude-led, Codex-executed workflow where Claude acts as architect and orchestrator, dispatching
                Codex agents to implement features in parallel.
              </p>
            </div>
          </CardContent>
        </Card>

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
              <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
                <Link href="/telegram/">
                  Open @PharosWatchBot
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          }
        />

        <Card className="rounded-xl border-l-[3px] border-l-frost-blue">
          <CardHeader className="space-y-2">
            <div className="flex items-center gap-3">
              <p className="pharos-kicker text-sky-700 dark:text-frost-blue/82">In the wild</p>
              <div className="h-px flex-1 bg-gradient-to-r from-frost-blue/35 to-transparent" />
            </div>
            <CardTitle as="h2">Live Walkthrough</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm leading-relaxed text-muted-foreground sm:flex-row sm:items-start">
            <Radio className="mt-0.5 h-5 w-5 shrink-0 text-sky-700 dark:text-frost-blue/82" />
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
          </CardContent>
        </Card>

        <Card className="rounded-xl border-l-[3px] border-l-violet-500">
          <CardHeader className="space-y-2">
            <div className="flex items-center gap-3">
              <p className="pharos-kicker text-violet-700 dark:text-violet-400">Governance lens</p>
              <div className="h-px flex-1 bg-gradient-to-r from-violet-500/35 to-transparent" />
            </div>
            <CardTitle as="h2">Classification</CardTitle>
          </CardHeader>
          <CardContent className="text-sm leading-relaxed text-muted-foreground">
            <p>
              Pharos classifies stablecoins into three governance tiers:{" "}
              <span className="font-medium text-foreground">CeFi</span> (fully centralized),{" "}
              <span className="font-medium text-foreground">CeFi-Dependent</span> (decentralized infrastructure but
              reliant on centralized collateral or peg mechanisms), and{" "}
              <span className="font-medium text-foreground">DeFi</span> (fully on-chain, no centralized custody
              dependency). The classification reflects actual infrastructure dependency, not marketing claims.
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-xl border-l-[3px] border-l-amber-500">
          <CardHeader className="space-y-2">
            <div className="flex items-center gap-3">
              <p className="pharos-kicker text-amber-700 dark:text-amber-400">Source flow</p>
              <div className="h-px flex-1 bg-gradient-to-r from-amber-500/35 to-transparent" />
            </div>
            <CardTitle as="h2">Data Pipeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 text-sm leading-relaxed text-muted-foreground">
            <p>
              All data is fetched server-side by a Cloudflare Worker and cached in D1. The browser never calls external
              APIs directly.
            </p>
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.95fr)]">
              <div className="space-y-4">
                <p className="text-sm font-semibold text-foreground">Source groups</p>
                <PipelineSources />
              </div>
              <div className="space-y-4 lg:border-l lg:border-border/60 lg:pl-6">
                <p className="text-sm font-semibold text-foreground">Processing path</p>
                <ol className="space-y-4">
                  <li className="flex gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/70 text-xs font-semibold text-foreground">
                      1
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">Sources</p>
                      <p>
                        Market, on-chain, ratings, FX, commodity, and digest inputs are collected on a fixed schedule.
                      </p>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/70 text-xs font-semibold text-foreground">
                      2
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">Cloudflare Worker + D1</p>
                      <p>
                        Cron jobs sync every 15 minutes, normalize the data, and cache the results for the public API.
                      </p>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/70 text-xs font-semibold text-foreground">
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
          </CardContent>
        </Card>

        <Card className="rounded-xl border-l-[3px] border-l-amber-500">
          <CardHeader className="space-y-2">
            <div className="flex items-center gap-3">
              <p className="pharos-kicker text-amber-700 dark:text-amber-400">Scoring details</p>
              <div className="h-px flex-1 bg-gradient-to-r from-amber-500/35 to-transparent" />
            </div>
            <CardTitle as="h2">Methodology</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
            <p>
              Pharos grades every stablecoin across four base dimensions, with peg stability acting as a multiplier on
              top. The methodology page covers the full grading formula, peg score computation, DEX liquidity scoring,
              and contagion stress-test design.
            </p>
            <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
              <Link href="/methodology/">
                Read the full methodology
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
          <CardHeader className="space-y-2">
            <div className="flex items-center gap-3">
              <p className="pharos-kicker">Important context</p>
              <div className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
            </div>
            <CardTitle as="h2">Disclaimer</CardTitle>
          </CardHeader>
          <CardContent className="text-sm leading-relaxed text-muted-foreground">
            <p>
              Pharos is an informational tool, not a licensed financial advisor. Nothing on this site constitutes
              financial, investment, or legal advice. All data is provided as-is and may contain errors or delays.
              Always do your own research and consult a qualified professional before making financial decisions.
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-xl border-l-[3px] border-l-frost-blue">
          <CardHeader className="space-y-2">
            <div className="flex items-center gap-3">
              <p className="pharos-kicker text-sky-700 dark:text-frost-blue/82">Reach out</p>
              <div className="h-px flex-1 bg-gradient-to-r from-frost-blue/35 to-transparent" />
            </div>
            <CardTitle as="h2">Get in Touch</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
            <p>
              Pharos is fully open source. If you spot a bad data point, want a stablecoin added, or want to understand
              how something is computed, open the code or reach out directly.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
                <a href="https://github.com/TokenBrice/stablecoin-dashboard" target="_blank" rel="noopener noreferrer">
                  <Github className="h-4 w-4" />
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
          </CardContent>
        </Card>
      </div>
    </FeaturePageShell>
  );
}
