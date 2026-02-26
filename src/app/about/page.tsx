import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Activity, BarChart3, ClipboardCheck, Droplets, ExternalLink, Gauge, Github, Layers, Network, Newspaper, ShieldAlert, ShieldCheck, Skull } from "lucide-react";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DEAD_STABLECOINS } from "@/lib/dead-stablecoins";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";

const DATA_SOURCE_GROUPS = [
  { label: "Supply & Price", sources: "DefiLlama, CoinGecko, CoinMarketCap, DexScreener" },
  { label: "On-chain Events", sources: "Etherscan v2, TronGrid" },
  { label: "Ratings & Reference", sources: "Bluechip, ECB, fawazahmed0/exchange-api, gold-api.com" },
  { label: "DEX Data", sources: "DeFiLlama Yields & Protocols, Curve Finance API, The Graph, GeckoTerminal" },
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
  title: "About Pharos — Light on Every Peg",
  description:
    "About Pharos — an open stablecoin analytics dashboard by TokenBrice. Honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
  alternates: {
    canonical: "/about/",
  },
  openGraph: {
    title: "About Pharos — Light on Every Peg",
    description:
      "About Pharos — an open stablecoin analytics dashboard by TokenBrice. Honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
    url: "/about/",
  },
};

export default function AboutPage() {
  return (
    <div className="space-y-8">
      <BreadcrumbJsonLd name="About Pharos" path="/about/" />
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
                  text: "Pharos is a project by TokenBrice and Claude. It puts the stablecoin data you want to monitor in one place — honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
                },
              },
              {
                "@type": "Question",
                name: "What does Pharos track?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: `Pharos tracks ${TRACKED_STABLECOINS.length} stablecoins across every major chain, classified by governance, backing, and peg currency. It documents ${DEAD_STABLECOINS.length} dead stablecoins in the cemetery, monitors USDC/USDT/PAXG/XAUT freeze events on-chain, provides composite peg scores with depeg detection and heatmaps, integrates independent Bluechip SMIDGE safety ratings, scores DEX liquidity depth 0–100 across decentralized exchanges, computes a daily Pharos Stability Index for ecosystem health, and issues report cards grading each stablecoin across 5 risk dimensions.`,
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
                  text: "All data is fetched server-side by a Cloudflare Worker and cached in D1. Sources include DefiLlama for supply, price, and chain distribution; CoinGecko for logos and fallback prices; CoinMarketCap and DexScreener as further price fallbacks; Etherscan v2 and TronGrid for on-chain freeze events; Bluechip for safety ratings; ECB and fawazahmed0/exchange-api for live FX rates; gold-api.com for gold and silver spot prices; and DeFiLlama Yields &amp; Protocols, Curve Finance API, The Graph, and GeckoTerminal for DEX liquidity data.",
                },
              },
            ],
          }),
        }}
      />

      {/* Section 1: Hero / Why Pharos */}
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">About Pharos</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">About Pharos</h1>
        <p className="text-sm text-muted-foreground">
          Open stablecoin analytics dashboard, built with love and care.
        </p>
      </div>

      <Card className="rounded-2xl border-l-[3px] border-l-sky-500">
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
                className="text-foreground underline underline-offset-4 hover:text-violet-500 transition-colors"
              >
                Claude
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
          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-amber-500" />
                <span className="font-bold">{TRACKED_STABLECOINS.length} Stablecoins</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Tracked across every major chain, classified by governance, backing, and peg currency
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Skull className="h-5 w-5 text-zinc-500" />
                <Link href="/cemetery" className="font-bold underline underline-offset-4 hover:text-zinc-500 transition-colors">{DEAD_STABLECOINS.length} in the Cemetery</Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Algorithmic failures, rug pulls, regulatory shutdowns, and quiet abandonments
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-red-500" />
                <Link href="/blacklist" className="font-bold underline underline-offset-4 hover:text-red-500 transition-colors">Freeze Tracking</Link>
              </div>
              <p className="text-sm text-muted-foreground">
                USDC, USDT, PAXG &amp; XAUT blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-emerald-500" />
                <Link href="/peg-tracker" className="font-bold underline underline-offset-4 hover:text-emerald-500 transition-colors">
                  Peg Tracker
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Composite peg scores, depeg event detection, heatmaps, and 4 years of history
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-sky-500" />
                <span className="font-bold">Safety Ratings</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Independent Bluechip SMIDGE grades for rated stablecoins —{" "}
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

          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Droplets className="h-5 w-5 text-cyan-500" />
                <Link href="/liquidity" className="font-bold underline underline-offset-4 hover:text-cyan-500 transition-colors">
                  DEX Liquidity
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Pool depth, volume, quality-adjusted TVL, durability, and cross-chain presence scored 0&ndash;100
              </p>
            </CardContent>
          </Card>

        </div>
      </div>

      {/* Section 3: What Pharos Computes */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">What Pharos Computes</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Newspaper className="h-5 w-5 text-orange-500" />
                <Link href="/digest" className="font-bold underline underline-offset-4 hover:text-orange-500 transition-colors">
                  Daily Digest
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                AI-written daily briefing on stablecoin market conditions — supply shifts, depeg alerts, and liquidity changes, updated every morning
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Gauge className="h-5 w-5 text-indigo-500" />
                <span className="font-bold">Stability Index</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Daily health score for the stablecoin ecosystem: aggregates peg integrity, supply growth, and liquidity depth into a 0&ndash;100 score
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <ClipboardCheck className="h-5 w-5 text-emerald-500" />
                <Link href="/risk-lab" className="font-bold underline underline-offset-4 hover:text-emerald-500 transition-colors">
                  Safety Grades
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Comprehensive A+&ndash;F stablecoin grades with five dimensions: peg, liquidity, resilience, decentralization, and dependency risk
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Network className="h-5 w-5 text-rose-500" />
                <Link href="/risk-lab" className="font-bold underline underline-offset-4 hover:text-rose-500 transition-colors">
                  Contagion Map
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Simulates the failure of any tracked stablecoin and traces how it cascades through dependent coins — quantifies ecosystem-wide contagion risk
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-violet-500" />
                <Link href="/risk-lab" className="font-bold underline underline-offset-4 hover:text-violet-500 transition-colors">
                  Effective Portfolio Exposure
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Traces collateral weights across your holdings to reveal true upstream exposure — see what fraction of your portfolio ultimately rests on each base asset
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Section 4: Classification */}
      <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
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
      <Card className="rounded-2xl border-l-[3px] border-l-zinc-500">
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

      {/* Section 5: Report Card Methodology */}
      <Card className="rounded-2xl border-l-[3px] border-l-amber-500">
        <CardHeader>
          <CardTitle as="h2">Grading Methodology</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Pharos synthesizes multiple data signals into a single transparent grade per stablecoin.
            Each report card distills peg stability, liquidity depth, resilience,
            decentralization, and dependency risk into a letter grade so you can compare stablecoins at a glance.
          </p>

          {/* Dimensions table */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Grading Dimensions</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">Dimension</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Weight</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Source</th>
                    <th className="py-2 font-medium text-foreground">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Peg Stability</td>
                    <td className="py-2 pr-4">25%</td>
                    <td className="py-2 pr-4">Peg score, depeg events</td>
                    <td className="py-2">How faithfully the coin holds its peg</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Liquidity</td>
                    <td className="py-2 pr-4">25%</td>
                    <td className="py-2 pr-4">DEX liquidity score</td>
                    <td className="py-2">Can you exit a large position without slippage?</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Resilience</td>
                    <td className="py-2 pr-4">15%</td>
                    <td className="py-2 pr-4">Chain count, freeze events</td>
                    <td className="py-2">Single points of failure and operational risk</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Decentralization</td>
                    <td className="py-2 pr-4">10%</td>
                    <td className="py-2 pr-4">Governance model</td>
                    <td className="py-2">Governance structure and custodial model</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Dependency Risk</td>
                    <td className="py-2 pr-4">25%</td>
                    <td className="py-2 pr-4">Dependencies, upstream grades</td>
                    <td className="py-2">Inherited risk from upstream stablecoins</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Grade thresholds */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Grade Thresholds</h3>
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-8 font-medium text-foreground">Grade</th>
                    <th className="py-2 font-medium text-foreground">Score Range</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr><td className="py-1.5 pr-8 text-foreground">A+</td><td className="py-1.5">97&ndash;100</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">A</td><td className="py-1.5">93&ndash;96</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">A&minus;</td><td className="py-1.5">90&ndash;92</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">B+</td><td className="py-1.5">85&ndash;89</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">B</td><td className="py-1.5">80&ndash;84</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">B&minus;</td><td className="py-1.5">75&ndash;79</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">C+</td><td className="py-1.5">70&ndash;74</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">C</td><td className="py-1.5">65&ndash;69</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">C&minus;</td><td className="py-1.5">60&ndash;64</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">D</td><td className="py-1.5">50&ndash;59</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">F</td><td className="py-1.5">0&ndash;49</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">NR</td><td className="py-1.5">Not enough data</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Key design decisions */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Key Design Decisions</h3>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground font-medium">NR (Not Rated)</span> is used when fewer than 3 dimensions have data &mdash; no misleading partial grades</li>
              <li>Weight is redistributed proportionally among rated dimensions when some are NR</li>
              <li>Cemetery (defunct) coins receive a permanent F</li>
              <li>Decentralization score is structural, not a value judgment</li>
            </ul>
          </div>

          {/* Limitations */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Limitations</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>Peg stability only reflects price data &mdash; can&apos;t detect coins &ldquo;stable&rdquo; because nobody trades them</li>
              <li>Decentralization is structural, not a value judgment</li>
              <li>Dependency map is manually maintained &mdash; may not capture every collateral relationship</li>
              <li>Resilience uses chain count as proxy &mdash; doesn&apos;t account for chain quality or TVL distribution per chain</li>
            </ul>
          </div>

          {/* Versioning */}
          <p className="text-xs text-muted-foreground italic">
            Methodology version v2.0. Version increments when weights, thresholds, or dimension definitions change.
          </p>
        </CardContent>
      </Card>

      {/* Section 6: Portfolio Analyzer & Stress Test Methodology */}
      <Card className="rounded-2xl border-l-[3px] border-l-emerald-500">
        <CardHeader>
          <CardTitle as="h2">Portfolio Analyzer &amp; Stress Test</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            The portfolio analyzer lets you input stablecoin holdings and receive an aggregate risk
            assessment. The stress test simulates dependency failures to reveal concentration risk.
          </p>

          {/* Portfolio Grade */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Portfolio Grade</h3>
            <p>
              The portfolio grade is a USD-weighted average of held coins&apos; overall scores:
            </p>
            <p className="font-mono text-xs bg-muted rounded px-3 py-2">
              portfolioScore = &Sigma;(coinScore &times; coinAmount) / &Sigma;(coinAmount)
            </p>
            <p>
              for all rated coins. Coins with an NR (Not Rated) grade are excluded from the
              weighted average but flagged in the UI.
            </p>
          </div>

          {/* Portfolio Radar */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Portfolio Radar</h3>
            <p>
              The portfolio radar chart shows the same weighted average applied per dimension
              (Peg Stability, Liquidity, Resilience, Decentralization, Dependency Risk),
              revealing the aggregate risk profile shape of the portfolio.
            </p>
          </div>

          {/* Upstream Exposure */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Upstream Exposure</h3>
            <p>
              For each holding, the dashboard traces the dependency graph using researched
              collateral weights to calculate effective exposure to upstream stablecoins.
              Direct holdings of centralized stablecoins (e.g., USDC, USDT) attribute 100%
              to themselves. Dependent coins split their exposure according to their collateral weights.
            </p>
            <p>
              <span className="text-foreground font-medium">Example:</span>{" "}
              $50K USDC (direct) + $5K DAI (85% USDC) + $2K FRAX (90% USDC)
              = $56,050 effective USDC exposure out of $57,000 total (98%).
            </p>
          </div>

          {/* Stress Test */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Stress Test</h3>
            <p>
              The interactive stress test overrides a target coin&apos;s overall score, then recomputes
              the Dependency Risk dimension for every coin that lists that target as an upstream
              dependency. This models the direct dependency channel only.
            </p>
            <p>
              In reality, a major stablecoin failure would also impact peg stability, liquidity,
              and market confidence simultaneously &mdash; the stress test captures only the
              mechanical dependency impact.
            </p>
          </div>

          {/* Limitations */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Limitations</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>Collateral weights are researched estimates that may not reflect real-time ratios</li>
              <li>Portfolio holdings are self-reported &mdash; no wallet connection or on-chain verification</li>
              <li>The stress test models only the dependency risk channel, not second-order market effects</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* Section 7: Footer */}
      <Card className="rounded-2xl border-l-[3px] border-l-sky-500">
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
  );
}
