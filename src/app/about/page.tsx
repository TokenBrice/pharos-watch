import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Activity, BarChart3, Droplets, ExternalLink, Github, ShieldAlert, ShieldCheck, Skull } from "lucide-react";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DEAD_STABLECOINS } from "@/lib/dead-stablecoins";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";

const DATA_SOURCE_GROUPS = [
  { label: "Supply & Price", sources: "DefiLlama, CoinGecko, CoinMarketCap, DexScreener" },
  { label: "On-chain Events", sources: "Etherscan v2, TronGrid" },
  { label: "Ratings & Reference", sources: "Bluechip, ECB, fawazahmed0/exchange-api, gold-api.com" },
  { label: "DEX Data", sources: "DeFiLlama Yields, Curve Finance API" },
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
                  text: `Pharos tracks ${TRACKED_STABLECOINS.length} stablecoins across every major chain, classified by governance, backing, and peg currency. It documents ${DEAD_STABLECOINS.length} dead stablecoins in the cemetery, monitors USDC/USDT/PAXG/XAUT freeze events on-chain, provides composite peg scores with depeg detection and heatmaps, integrates independent Bluechip SMIDGE safety ratings, and scores DEX liquidity depth 0–100 across decentralized exchanges.`,
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
                  text: "All data is fetched server-side by a Cloudflare Worker and cached in D1. Sources include DefiLlama for supply, price, and chain distribution; CoinGecko for logos and fallback prices; CoinMarketCap and DexScreener as further price fallbacks; Etherscan v2 and TronGrid for on-chain freeze events; Bluechip for safety ratings; ECB and fawazahmed0/exchange-api for live FX rates; gold-api.com for gold and silver spot prices; and DeFiLlama Yields plus Curve Finance API for DEX liquidity data.",
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
          An open stablecoin analytics dashboard.
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
              . It puts the stablecoin data you want to monitor in one place — honest
              classification, freeze tracking, and a graveyard for the ones that didn&apos;t make it.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: What Pharos Tracks (Feature Icon Grid) */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">What Pharos Tracks</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Card className="rounded-2xl">
            <CardContent className="pt-4 space-y-2">
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
            <CardContent className="pt-4 space-y-2">
              <div className="flex items-center gap-2">
                <Skull className="h-5 w-5 text-zinc-500" />
                <span className="font-bold">{DEAD_STABLECOINS.length} in the Cemetery</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Algorithmic failures, rug pulls, regulatory shutdowns, and quiet abandonments
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardContent className="pt-4 space-y-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-red-500" />
                <span className="font-bold">Freeze Tracking</span>
              </div>
              <p className="text-sm text-muted-foreground">
                USDC, USDT, PAXG &amp; XAUT blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardContent className="pt-4 space-y-2">
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
            <CardContent className="pt-4 space-y-2">
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
            <CardContent className="pt-4 space-y-2">
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

      {/* Section 3: Classification */}
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

      {/* Section 5: Footer */}
      <div className="text-sm text-muted-foreground pb-4 space-y-2">
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
      </div>
    </div>
  );
}
