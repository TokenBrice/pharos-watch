import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Activity, BarChart3, Droplets, ExternalLink, Flame, FlaskConical, Gauge, Github, Layers, Network, Newspaper, Radio, ShieldAlert, ShieldCheck, Skull } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

const DATA_SOURCE_GROUPS = [
  { label: "Supply & Price", sources: "DefiLlama, CoinGecko, CoinMarketCap, DexScreener" },
  { label: "On-chain Reads & Events", sources: "Etherscan v2 (freeze events, mint/burn flows), TronGrid, Alchemy & dRPC (EVM RPCs, including direct Liquity/B.Protocol reads)" },
  { label: "Ratings & Reference", sources: "Bluechip, ECB via Frankfurter, fawazahmed0/exchange-api, gold-api.com, FRED DGS3MO (T-bill rates)" },
  { label: "DEX Data", sources: "DeFiLlama Yields & Protocols, Curve Finance API, The Graph, GeckoTerminal, DexScreener" },
  { label: "AI Generation", sources: "Anthropic Claude (daily digest)" },
] as const;

function PipelineSources() {
  return (
    <>
      {DATA_SOURCE_GROUPS.map((g) => (
        <div key={g.label}>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{g.label}</p>
          <p className="text-sm text-foreground">{g.sources}</p>
        </div>
      ))}
    </>
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
  return (
    <FeaturePageShell
      breadcrumbName="About Pharos"
      path="/about/"
      title="About Pharos"
      leadParagraphs={["Open stablecoin analytics dashboard, built with love and care."]}
      preface={(
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
                    text: "All data is fetched server-side by a Cloudflare Worker and cached in D1. Sources include DefiLlama for supply, price, and chain distribution; CoinGecko for logos and fallback prices; CoinMarketCap and DexScreener as further price fallbacks; Etherscan v2, TronGrid, Alchemy, and dRPC for on-chain freeze events, mint/burn flow tracking, and direct contract calls including Liquity/B.Protocol yield reads; Bluechip for safety ratings; ECB via Frankfurter and fawazahmed0/exchange-api for live FX rates; gold-api.com for gold and silver spot prices; FRED DGS3MO for T-bill rates; DeFiLlama Yields &amp; Protocols, Curve Finance API, The Graph, and GeckoTerminal for DEX liquidity data; and Anthropic Claude for daily digest generation.",
                  },
                },
              ],
            }),
          }}
        />
      )}
    >
      <div className="space-y-8">
      <Card className="rounded-xl border-l-[3px] border-l-sky-500">
        <CardHeader>
          <CardTitle as="h2">Why Pharos?</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-5 text-sm text-muted-foreground leading-relaxed">
          <div className="flex flex-col sm:flex-row gap-3 shrink-0">
            <Image
              src="/tokenbrice.png"
              alt="TokenBrice"
              width={80}
              height={80}
              className="rounded-xl h-16 w-16 sm:h-20 sm:w-20"
            />
            <Image
              src="/claude.png"
              alt="Claude"
              width={80}
              height={80}
              className="rounded-xl h-16 w-16 sm:h-20 sm:w-20"
            />
            <Image
              src="/codex.svg"
              alt="Codex"
              width={80}
              height={80}
              className="rounded-xl h-16 w-16 sm:h-20 sm:w-20"
            />
          </div>
          <div className="space-y-3">
            <p>
              Pharos is a project by{" "}
              <a
                href="https://tokenbrice.xyz/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
              >
                TokenBrice
                <ExternalLink className="inline h-3.5 w-3.5 ml-0.5 -mt-0.5" />
              </a>
              {" "}and{" "}
              <a
                href="https://www.anthropic.com/claude-code"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
              >
                Claude
                <ExternalLink className="inline h-3.5 w-3.5 ml-0.5 -mt-0.5" />
              </a>
              {", and "}
              <a
                href="https://openai.com/codex/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
              >
                Codex
                <ExternalLink className="inline h-3.5 w-3.5 ml-0.5 -mt-0.5" />
              </a>
              . It puts the stablecoin data you want to monitor in one place: honest
              classification, depeg and freeze tracking, liquidity scoring, daily digests and a graveyard for the ones that didn&apos;t make it.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: What Pharos Tracks (Feature Icon Grid) */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">What Pharos Tracks</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-amber-700 dark:text-amber-400" />
                <span className="font-bold">{TRACKED_STABLECOINS.length} Stablecoins</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Tracked across every major chain, classified by governance, backing, and peg currency
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Skull className="h-5 w-5 text-zinc-700 dark:text-zinc-400" />
                <Link href="/cemetery" className="font-bold underline underline-offset-4 hover:text-zinc-500 transition-colors">{DEAD_STABLECOINS.length} in the Cemetery</Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Algorithmic failures, rug pulls, regulatory shutdowns, and quiet abandonments
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-red-700 dark:text-red-400" />
                <Link href="/blacklist" className="font-bold underline underline-offset-4 hover:text-red-500 transition-colors">Blacklist Tracker</Link>
              </div>
              <p className="text-sm text-muted-foreground">
                USDC, USDT, PAXG &amp; XAUT blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-emerald-700 dark:text-emerald-400" />
                <Link href="/" className="font-bold underline underline-offset-4 hover:text-emerald-500 transition-colors">
                  Peg Tracker
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Composite peg scores, depeg event detection, heatmaps, and 4 years of history
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-sky-700 dark:text-sky-400" />
                <span className="font-bold">Safety Ratings</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Independent Bluechip SMIDGE grades for rated stablecoins via{" "}
                <a
                  href="https://bluechip.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
                >
                  bluechip.org
                  <ExternalLink className="inline h-3.5 w-3.5 ml-0.5 -mt-0.5" />
                </a>
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Droplets className="h-5 w-5 text-cyan-700 dark:text-cyan-400" />
                <Link href="/liquidity" className="font-bold underline underline-offset-4 hover:text-cyan-500 transition-colors">
                  DEX Liquidity
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Pool depth, volume, quality-adjusted TVL, durability, and cross-chain presence scored 0&ndash;100
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Flame className="h-5 w-5 text-orange-700 dark:text-orange-400" />
                <Link href="/flows" className="font-bold underline underline-offset-4 hover:text-orange-500 transition-colors">
                  Mint/Burn Flows
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                On-chain Transfer event monitoring via Etherscan for real-time mint and burn flow tracking, with a Bank Run Gauge and flight-to-quality detection
              </p>
            </CardContent>
          </Card>

        </div>
      </div>

      {/* Section 3: What Pharos Computes */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">What Pharos Computes</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Newspaper className="h-5 w-5 text-orange-700 dark:text-orange-400" />
                <Link href="/digest" className="font-bold underline underline-offset-4 hover:text-orange-500 transition-colors">
                  Daily Digest
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                AI-written daily briefing on stablecoin market conditions covering supply shifts, depeg alerts, and liquidity changes, updated every morning
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Gauge className="h-5 w-5 text-indigo-700 dark:text-indigo-400" />
                <a href="/stability-index" className="font-bold hover:underline">Pharos Stability Index (PSI)</a>
              </div>
              <p className="text-sm text-muted-foreground">
                Daily health score for the stablecoin ecosystem: aggregates peg integrity, supply growth, and liquidity depth into a 0&ndash;100 score
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <FlaskConical className="h-5 w-5 text-emerald-700 dark:text-emerald-400" />
                <Link href="/safety-scores" className="font-bold underline underline-offset-4 hover:text-emerald-500 transition-colors">
                  Safety Grades
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Comprehensive A+&ndash;F stablecoin grades: four base dimensions (liquidity, resilience, decentralization, dependency risk) with a peg stability multiplier
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Network className="h-5 w-5 text-rose-700 dark:text-rose-400" />
                <Link href="/safety-scores" className="font-bold underline underline-offset-4 hover:text-rose-500 transition-colors">
                  Contagion Map
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Simulates the failure of any tracked stablecoin and traces how it cascades through dependent coins, quantifying ecosystem-wide contagion risk
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-violet-700 dark:text-violet-400" />
                <Link href="/safety-scores" className="font-bold underline underline-offset-4 hover:text-violet-500 transition-colors">
                  Systemic Risk Scoreboard
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Pre-computes the most damaging single-coin failure scenarios across the ecosystem to reveal which failures would cause the most collateral damage
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-amber-700 dark:text-amber-400" />
                <span className="font-bold">Depeg Early Warning (DEWS)</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Per-coin forward-looking stress score (0&ndash;100) computed every 15 minutes from 8 sub-signals: supply velocity, pool balance drift, liquidity erosion, price confidence, cross-source divergence, blacklist activity, mint/burn flow, and yield anomaly
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Section: Learn More About Pharos */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Learn More About Pharos</h2>
        <Card className="rounded-xl border-l-[3px] border-l-sky-500">
          <CardContent className="flex items-start gap-4 text-sm text-muted-foreground leading-relaxed">
            <Radio className="h-5 w-5 text-sky-700 dark:text-sky-400 mt-0.5 shrink-0" />
            <div className="space-y-2">
              <p>
                TokenBrice walked through Pharos live on Leviathan News — covering the motivation behind the project, how the data pipeline works, and what each metric means in practice.
              </p>
              <a
                href="https://x.com/i/broadcasts/1qxvvkeMlyAxB"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
              >
                Watch the broadcast on Leviathan News
                <ExternalLink className="inline h-3.5 w-3.5" />
              </a>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Section 4: Classification */}
      <Card className="rounded-xl border-l-[3px] border-l-violet-500">
        <CardHeader>
          <CardTitle as="h2">Classification</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground leading-relaxed">
          <p>
            Pharos classifies stablecoins into three governance tiers:{" "}
            <span className="text-foreground font-medium">CeFi</span> (fully centralized),{" "}
            <span className="text-foreground font-medium">CeFi-Dependent</span> (decentralized infrastructure but reliant on centralized collateral or peg mechanisms), and{" "}
            <span className="text-foreground font-medium">DeFi</span> (fully on-chain, no centralized custody dependency).
            This reflects actual infrastructure dependency, not marketing claims.
          </p>
        </CardContent>
      </Card>

      {/* Section 4: Data Pipeline Diagram */}
      <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
        <CardHeader>
          <CardTitle as="h2">Data Pipeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5 text-sm text-muted-foreground leading-relaxed">
          <p>
            All data is fetched server-side by a Cloudflare Worker and cached in D1. The browser never calls external APIs.
          </p>

          {/* Desktop: horizontal 5-column grid */}
          <div className="hidden md:grid grid-cols-[1fr_auto_1fr_auto_1fr] gap-4 items-start">
            {/* Sources column */}
            <div className="space-y-4 rounded-lg border p-4">
              <p className="text-foreground font-medium text-center">Sources</p>
              <div className="space-y-3">
                <PipelineSources />
              </div>
            </div>

            {/* Arrow */}
            <div className="flex items-center self-center text-muted-foreground text-xl font-bold">
              &rarr;
            </div>

            {/* Worker column */}
            <div className="rounded-lg border p-4 text-center self-center">
              <p className="text-foreground font-medium">Cloudflare Worker + D1</p>
              <p className="text-xs text-muted-foreground mt-1">Cron sync every 15 min</p>
            </div>

            {/* Arrow */}
            <div className="flex items-center self-center text-muted-foreground text-xl font-bold">
              &rarr;
            </div>

            {/* Dashboard column */}
            <div className="rounded-lg border p-4 text-center self-center">
              <p className="text-foreground font-medium">Static Dashboard</p>
              <p className="text-xs text-muted-foreground mt-1">Next.js on Cloudflare Pages</p>
            </div>
          </div>

          {/* Mobile: vertical stack */}
          <div className="flex flex-col items-center gap-3 md:hidden">
            {/* Sources */}
            <div className="w-full space-y-3 rounded-lg border p-4">
              <p className="text-foreground font-medium text-center">Sources</p>
              <div className="space-y-3">
                <PipelineSources />
              </div>
            </div>

            {/* Arrow down */}
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>

            {/* Worker */}
            <div className="w-full rounded-lg border p-4 text-center">
              <p className="text-foreground font-medium">Cloudflare Worker + D1</p>
              <p className="text-xs text-muted-foreground mt-1">Cron sync every 15 min</p>
            </div>

            {/* Arrow down */}
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>

            {/* Dashboard */}
            <div className="w-full rounded-lg border p-4 text-center">
              <p className="text-foreground font-medium">Static Dashboard</p>
              <p className="text-xs text-muted-foreground mt-1">Next.js on Cloudflare Pages</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Methodology link */}
      <Card className="rounded-xl border-l-[3px] border-l-amber-500">
        <CardHeader>
          <CardTitle as="h2">Methodology</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-2">
          <p>
            Pharos grades every stablecoin across four dimensions &mdash; liquidity, resilience,
            decentralization, and dependency risk &mdash; with a peg stability multiplier.
            The methodology page covers the full grading formula, peg score computation,
            DEX liquidity scoring, and contagion stress test design.
          </p>
          <p>
            <Link
              href="/methodology"
              className="text-foreground underline underline-offset-4 hover:text-amber-500 transition-colors"
            >
              Read the full methodology &rarr;
            </Link>
          </p>
        </CardContent>
      </Card>

      {/* Section 7: Disclaimer */}
      <Card className="rounded-xl border-l-[3px] border-l-amber-500">
        <CardHeader>
          <CardTitle as="h2">Disclaimer</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-2">
          <p>
            Pharos is an informational tool, not a licensed financial advisor. Nothing on this site
            constitutes financial, investment, or legal advice. All data is provided as-is and may contain
            errors or delays. Always do your own research and consult a qualified professional before making
            financial decisions.
          </p>
        </CardContent>
      </Card>

      {/* Section 8: Footer */}
      <Card className="rounded-xl border-l-[3px] border-l-sky-500">
        <CardHeader>
          <CardTitle as="h2">Get in Touch</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-2">
          <p>
            Pharos is fully open source.{" "}
            <a
              href="https://github.com/TokenBrice/stablecoin-dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
            >
              <Github className="inline h-3.5 w-3.5" />
              View on GitHub
              <ExternalLink className="inline h-3.5 w-3.5" />
            </a>
          </p>
          <p>
            Questions, corrections, or stablecoins we should add? Reach out on{" "}
            <a
              href="https://x.com/PharosWatch"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
            >
              @PharosWatch
              <ExternalLink className="inline h-3.5 w-3.5 ml-0.5 -mt-0.5" />
            </a>
            {" "}or{" "}
            <a
              href="https://tokenbrice.xyz/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
            >
              tokenbrice.xyz
              <ExternalLink className="inline h-3.5 w-3.5 ml-0.5 -mt-0.5" />
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </div>
    </FeaturePageShell>
  );
}
