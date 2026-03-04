import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { MethodologyModeToggle } from "@/components/methodology-mode-toggle";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SAFETY_SCORE_VERSION_LABEL } from "@/lib/safety-score-version";
import { PSI_METHODOLOGY_VERSION_LABEL } from "@/lib/stability-index-version";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@/lib/blacklist-tracker-version";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@/lib/depeg-dews-version";
import { LIQUIDITY_METHODOLOGY_VERSION_LABEL } from "@/lib/liquidity-score-version";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@/lib/mint-burn-flow-version";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@/lib/yield-methodology-version";

const METHODOLOGY_SECTIONS = [
  { id: "stability-index-methodology", label: "Stability Index" },
  { id: "safety-scores-methodology", label: "Safety Scores" },
  { id: "liquidity-methodology", label: "Liquidity Score" },
  { id: "mint-burn-flow-methodology", label: "Mint/Burn Flow" },
  { id: "yield-intelligence-methodology", label: "Yield Intelligence" },
  { id: "pegscore-dews-methodology", label: "PegScore + DEWS" },
  { id: "contagion-stress-test-methodology", label: "Contagion Test" },
  { id: "blacklist-tracker-methodology", label: "Blacklist Tracker" },
];

function MethodologyDetails({
  children,
  summary,
  defaultOpen = false,
  primary = false,
}: {
  children: ReactNode;
  summary: string;
  defaultOpen?: boolean;
  primary?: boolean;
}) {
  return (
    <details
      data-methodology-details="true"
      data-methodology-primary={primary ? "true" : undefined}
      open={defaultOpen}
      className="group rounded-lg border border-border/60 bg-muted/20"
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">
        {summary}
      </summary>
      <div className="space-y-6 px-4 pb-4">{children}</div>
    </details>
  );
}

function MethodologyFacts({
  facts,
}: {
  facts: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {facts.map((fact) => (
        <div key={fact.label} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          <p className="text-xs uppercase tracking-wide">{fact.label}</p>
          <p className="text-foreground">{fact.value}</p>
        </div>
      ))}
    </div>
  );
}

function WorkedExample({
  children,
  summary,
}: {
  children: ReactNode;
  summary: string;
}) {
  return (
    <details
      data-methodology-worked-example="true"
      className="rounded-lg border border-border/60 bg-background/80"
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">{summary}</summary>
      <div className="space-y-2 px-4 pb-4 text-xs text-muted-foreground leading-relaxed">{children}</div>
    </details>
  );
}

export const metadata: Metadata = {
  title: "Methodology: How Pharos Grades Stablecoins",
  description:
    "Full methodology behind Pharos safety grades, peg scores, liquidity scores, and contagion stress tests. Transparent scoring for every stablecoin.",
  alternates: {
    canonical: "/methodology/",
  },
  openGraph: {
    title: "Methodology: How Pharos Grades Stablecoins",
    description:
      "Full methodology behind Pharos safety grades, peg scores, liquidity scores, and contagion stress tests. Transparent scoring for every stablecoin.",
    url: "/methodology/",
    images: [{ url: "https://pharos.watch/og-methodology.png", width: 1200, height: 628 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-methodology.png", width: 1200, height: 628 }],
  },
};

export default function MethodologyPage() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <BreadcrumbJsonLd name="Methodology" path="/methodology/" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: "How does Pharos grade stablecoins?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: `Pharos computes a weighted average of four base dimensions — Liquidity (30%), Resilience (20%), Decentralization (15%), and Dependency Risk (25%) — then applies a peg stability power-curve multiplier. When liquidity data is absent, a 10% penalty is applied instead of redistributing the weight. Grades range from A+ (87+) to F (0–39), with NR for insufficient data. The methodology is currently at ${SAFETY_SCORE_VERSION_LABEL}.`,
                },
              },
              {
                "@type": "Question",
                name: "How is the Pharos peg score calculated?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "The peg score is a composite 0–100 measure combining time-at-peg (50%) and event severity (50%), minus penalties for active depegs and erratic behavior. The tracking window spans up to 4 years but is capped at the coin's actual age. It requires at least 30 days of tracking data.",
                },
              },
              {
                "@type": "Question",
                name: "How does Pharos measure DEX liquidity?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "The liquidity score is a composite 0–100 metric combining TVL depth (30%), volume activity (20%), pool quality (20%), durability (15%), pair diversity (7.5%), and cross-chain presence (7.5%). Pool quality is adjusted for mechanism type, balance health, and pair quality.",
                },
              },
            ],
          }),
        }}
      />

      {/* Breadcrumb + heading */}
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Methodology</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Methodology</h1>
        <p className="text-sm text-muted-foreground">
          How Pharos grades stablecoins — transparent scoring across safety, peg stability, liquidity, and contagion risk.
        </p>
      </div>

      <div className="sticky top-14 md:top-0 z-30 -mx-4 border-y border-border/60 bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Jump to Section</p>
          <div className="hidden md:block">
            <MethodologyModeToggle />
          </div>
        </div>
        <nav aria-label="Methodology section controls" className="mt-2 flex gap-2 overflow-x-auto scrollbar-none">
          {METHODOLOGY_SECTIONS.map((section) => (
            <a
              key={`sticky-${section.id}`}
              href={`#${section.id}`}
              className="shrink-0 whitespace-nowrap rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:border-foreground/30 hover:bg-muted"
            >
              {section.label}
            </a>
          ))}
        </nav>
      </div>

      <Card className="rounded-xl border-dashed border-border/70 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <CardHeader className="space-y-2">
          <CardTitle as="h2">How to Read This Page</CardTitle>
          <p className="text-xs text-muted-foreground">
            Start with each section&apos;s summary, then expand technical details only when you need formulas and edge cases.
          </p>
          <p className="text-xs text-muted-foreground">
            Analyst mode expands all technical sections automatically.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Cadence</p>
              <p className="text-sm text-foreground">Most models refresh every 15–30m</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Interpretation</p>
              <p className="text-sm text-foreground">Higher scores = healthier conditions</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Transparency</p>
              <p className="text-sm text-foreground">Every model has a versioned changelog</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card id="stability-index-methodology" className="scroll-mt-28 rounded-xl border-l-[3px] border-l-cyan-500">
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Stability Index Methodology</CardTitle>
            <span className="inline-flex items-center rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-cyan-500">
              {PSI_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link href="/methodology/stability-index-changelog" className="text-xs text-foreground underline underline-offset-4 hover:text-cyan-500 transition-colors">
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when PSI formula, caps, bands, or component definitions change.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            The Pharos Stability Index (PSI) is a market-level 0&ndash;100 health score for the stablecoin ecosystem.
            It is recomputed every 15 minutes from live depeg conditions and stress signals, then aggregated into
            daily history snapshots.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Update cadence</p>
              <p className="text-foreground">15m refresh</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Score range</p>
              <p className="text-foreground">0-100 market health</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Main use</p>
              <p className="text-foreground">Bands: BEDROCK to MELTDOWN</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                { label: "Minimum data", value: "No minimum; scorer accepts empty depeg sets" },
                { label: "Required sources", value: "Market-cap totals + active depeg inputs (DEWS breadth optional)" },
                { label: "Failure behavior", value: "Never null; output is clamped to [0,100] and rounded to 0.1" },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against computeStabilityIndex)">
            <p className="font-mono">
              Inputs: bps=-120, depegMcap=$2B, totalMcap=$200B, age=10d, trend=+1.2, stressBreadth=1.5
            </p>
            <p className="font-mono">
              severity=1.141, breadth=4.243, score=100-1.141-4.243-1.5+1.2=94.316&rarr;94.3
            </p>
            <p>Result: <span className="text-foreground">PSI 94.3 (BEDROCK)</span>.</p>
          </WorkedExample>

          <MethodologyDetails
            defaultOpen
            primary
            summary="Technical details: formula, component math, depeg handling, and condition bands"
          >

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Scoring Formula</h3>
            <code className="block rounded-lg border bg-muted px-4 py-3 text-xs font-mono">
              Score = 100 &minus; severity &minus; breadth &minus; stressBreadth + trend
            </code>
            <p className="text-xs">
              The final value is clamped to [0, 100] and rounded to one decimal.
            </p>
          </div>

          {/* PSI pipeline — desktop */}
          <div className="hidden md:flex flex-col items-center gap-3">
            <div className="grid grid-cols-4 gap-3 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Severity</p>
                <p className="text-xs text-muted-foreground mt-0.5">0&ndash;68</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Breadth</p>
                <p className="text-xs text-muted-foreground mt-0.5">0&ndash;17</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Stress Breadth</p>
                <p className="text-xs text-muted-foreground mt-0.5">0&ndash;5</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Trend</p>
                <p className="text-xs text-muted-foreground mt-0.5">&minus;5 to +5</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border p-3 text-center w-80">
              <p className="text-foreground font-medium">Compute PSI</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                100 &minus; penalties + trend
              </p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border border-cyan-500/40 p-3 text-center w-80">
              <p className="text-foreground font-medium">Condition Band</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                BEDROCK through MELTDOWN
              </p>
            </div>
          </div>

          {/* PSI pipeline — mobile */}
          <div className="flex flex-col items-center gap-3 md:hidden">
            <div className="grid grid-cols-2 gap-2 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Severity</p>
                <p className="text-xs text-muted-foreground">0&ndash;68</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Breadth</p>
                <p className="text-xs text-muted-foreground">0&ndash;17</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Stress Breadth</p>
                <p className="text-xs text-muted-foreground">0&ndash;5</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Trend</p>
                <p className="text-xs text-muted-foreground">&minus;5 to +5</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Compute PSI</p>
              <p className="text-xs text-muted-foreground mt-0.5">100 &minus; penalties + trend</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border border-cyan-500/40 p-3 text-center">
              <p className="text-foreground font-medium">Condition Band</p>
              <p className="text-xs text-muted-foreground mt-0.5">BEDROCK through MELTDOWN</p>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Components</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">Component</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Range</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Formula</th>
                    <th className="py-2 font-medium text-foreground">Purpose</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Severity</td>
                    <td className="py-2 pr-4">0&ndash;68</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      min(68, &Sigma;(abs(bps)/100 &times; share &times; log2(1+mcap/1B) &times; 60 &times; factor))
                    </td>
                    <td className="py-2">Magnitude-weighted depeg damage with extra emphasis on mega-cap instability</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Breadth</td>
                    <td className="py-2 pr-4">0&ndash;17</td>
                    <td className="py-2 pr-4 font-mono text-xs">min(17, &Sigma;(sqrt(mcap/1B) &times; 3 &times; factor))</td>
                    <td className="py-2">How widely depegs are spreading across unique coins</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Stress Breadth</td>
                    <td className="py-2 pr-4">0&ndash;5</td>
                    <td className="py-2 pr-4 font-mono text-xs">min(5, dewsStressBreadth)</td>
                    <td className="py-2">Early-warning pressure from DEWS stress signals before full depegs</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Trend</td>
                    <td className="py-2 pr-4">&minus;5 to +5</td>
                    <td className="py-2 pr-4 font-mono text-xs">clamp(-5, 5, mcap7dChangePct)</td>
                    <td className="py-2">7-day stablecoin market-cap momentum (supports or offsets penalties)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Depeg Handling Rules</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>
                <span className="text-foreground font-medium">Per-coin deduplication:</span> active events are grouped by coin;
                each coin contributes once using the worst current deviation.
              </li>
              <li>
                <span className="text-foreground font-medium">Age-aware depreciation:</span> fresh depegs get full weight for 30 days,
                then decay linearly to a 25% floor over 120 days.
              </li>
            </ul>
            <code className="block rounded-lg border bg-muted px-4 py-3 text-xs font-mono">
              factor = ageDays &le; 30 ? 1.0 : max(0.25, 1.0 &minus; (ageDays &minus; 30)/120)
            </code>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Condition Bands</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">Range</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Band</th>
                    <th className="py-2 font-medium text-foreground">Meaning</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr><td className="py-2 pr-4">90&ndash;100</td><td className="py-2 pr-4 text-green-500 font-medium">BEDROCK</td><td className="py-2">Near-ideal market stability</td></tr>
                  <tr><td className="py-2 pr-4">75&ndash;89</td><td className="py-2 pr-4 text-teal-500 font-medium">STEADY</td><td className="py-2">Normal conditions with minor stress</td></tr>
                  <tr><td className="py-2 pr-4">60&ndash;74</td><td className="py-2 pr-4 text-yellow-500 font-medium">TREMOR</td><td className="py-2">Meaningful instability emerging</td></tr>
                  <tr><td className="py-2 pr-4">40&ndash;59</td><td className="py-2 pr-4 text-orange-500 font-medium">FRACTURE</td><td className="py-2">Broad, significant market stress</td></tr>
                  <tr><td className="py-2 pr-4">20&ndash;39</td><td className="py-2 pr-4 text-red-500 font-medium">CRISIS</td><td className="py-2">Contagion-level instability</td></tr>
                  <tr><td className="py-2 pr-4">0&ndash;19</td><td className="py-2 pr-4 text-red-800 font-medium">MELTDOWN</td><td className="py-2">Systemic peg failure conditions</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* Grading Methodology */}
      <Card id="safety-scores-methodology" className="scroll-mt-28 rounded-xl border-l-[3px] border-l-amber-500">
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Safety Scores Grading Methodology</CardTitle>
            <span className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-amber-500">
              {SAFETY_SCORE_VERSION_LABEL}
            </span>
            <Link href="/methodology/scoring-changelog" className="text-xs text-foreground underline underline-offset-4 hover:text-amber-500 transition-colors">
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when weights, thresholds, or dimension definitions change.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Pharos synthesizes multiple data signals into a single transparent grade per stablecoin.
            The overall score is computed in two steps: first, a weighted average of four base dimensions
            (liquidity, resilience, decentralization, dependency risk), then a peg stability multiplier
            that penalizes coins with poor pegs while barely affecting well-pegged ones.
            When some base dimensions lack data (NR), their weight is redistributed proportionally among rated ones.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Model shape</p>
              <p className="text-foreground">4 dimensions + peg multiplier</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Grade output</p>
              <p className="text-foreground">A+ to F, with NR</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Key caveat</p>
              <p className="text-foreground">No DEX data = 10% penalty</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                { label: "Minimum data", value: "At least 2 rated non-peg dimensions" },
                { label: "Required sources", value: "Peg summary, DEX liquidity, and dependency/metadata inputs" },
                { label: "Failure behavior", value: "NR if peg is missing on non-NAV coins; no-liquidity applies 0.9 multiplier" },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against computeOverallGrade)">
            <p className="font-mono">
              Inputs: Liq 80, Res 70, Decen 60, Dep 75, Peg 92
            </p>
            <p className="font-mono">
              base=(80*0.30+70*0.20+60*0.15+75*0.25)/0.90=73.06
            </p>
            <p className="font-mono">
              final=round(base*(92/100)^0.20)=round(73.06*0.9835)=72
            </p>
            <p>Result: <span className="text-foreground">Score 72 (grade B)</span>.</p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: full pipeline, dimension formulas, thresholds, and caveats">

          {/* Scoring pipeline diagram — desktop: horizontal dimension row then vertical flow */}
          <div className="hidden md:flex flex-col items-center gap-3">
            <div className="grid grid-cols-4 gap-3 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Liquidity</p>
                <p className="text-xs text-muted-foreground mt-0.5">30%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Resilience</p>
                <p className="text-xs text-muted-foreground mt-0.5">20%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Decentralization</p>
                <p className="text-xs text-muted-foreground mt-0.5">15%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Dependency Risk</p>
                <p className="text-xs text-muted-foreground mt-0.5">25%</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border p-3 text-center w-64">
              <p className="text-foreground font-medium">Weighted Average</p>
              <p className="text-xs text-muted-foreground mt-0.5">base score</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border p-3 text-center w-64">
              <p className="text-foreground font-medium">&times; Peg Multiplier</p>
              <p className="text-xs text-muted-foreground mt-0.5">(pegScore / 100)<sup>0.20</sup></p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border border-amber-500/40 p-3 text-center w-64">
              <p className="text-foreground font-medium">&times; No-Liquidity Penalty</p>
              <p className="text-xs text-muted-foreground mt-0.5">0.9&times; if no DEX data</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border p-3 text-center w-64">
              <p className="text-foreground font-medium">Final Grade</p>
              <p className="text-xs text-muted-foreground mt-0.5">A+ through F</p>
            </div>
          </div>

          {/* Scoring pipeline diagram — mobile: vertical stack */}
          <div className="flex flex-col items-center gap-3 md:hidden">
            <div className="grid grid-cols-2 gap-2 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Liquidity</p>
                <p className="text-xs text-muted-foreground">30%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Resilience</p>
                <p className="text-xs text-muted-foreground">20%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Decentralization</p>
                <p className="text-xs text-muted-foreground">15%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Dep. Risk</p>
                <p className="text-xs text-muted-foreground">25%</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Weighted Average</p>
              <p className="text-xs text-muted-foreground mt-0.5">base score</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">&times; Peg Multiplier</p>
              <p className="text-xs text-muted-foreground mt-0.5">(pegScore / 100)<sup>0.20</sup></p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border border-amber-500/40 p-3 text-center">
              <p className="text-foreground font-medium">&times; No-Liquidity Penalty</p>
              <p className="text-xs text-muted-foreground mt-0.5">0.9&times; if no DEX data</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Final Grade</p>
              <p className="text-xs text-muted-foreground mt-0.5">A+ through F</p>
            </div>
          </div>

          {/* Dimensions table */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Base Dimensions (weighted average)</h3>
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
                    <td className="py-2 pr-4 text-foreground">Liquidity</td>
                    <td className="py-2 pr-4">30%</td>
                    <td className="py-2 pr-4">DEX liquidity score</td>
                    <td className="py-2">Direct passthrough of the liquidity score (see below)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Resilience</td>
                    <td className="py-2 pr-4">20%</td>
                    <td className="py-2 pr-4">Collateral, custody, blacklist</td>
                    <td className="py-2">Structural resilience across 3 equally-weighted sub-factors</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Decentralization</td>
                    <td className="py-2 pr-4">15%</td>
                    <td className="py-2 pr-4">Governance type, chain risk</td>
                    <td className="py-2">Governance structure with chain-risk penalty</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Dependency Risk</td>
                    <td className="py-2 pr-4">25%</td>
                    <td className="py-2 pr-4">Upstream grades, collateral weights</td>
                    <td className="py-2">Inherited risk from upstream stablecoins, weighted by exposure</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Peg multiplier */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Peg Stability Multiplier</h3>
            <p>
              After computing the base score, peg stability is applied as a power-curve multiplier:
              final&nbsp;=&nbsp;base&nbsp;&times;&nbsp;(pegScore&nbsp;/&nbsp;100)<sup>0.20</sup>.
              Coins with strong pegs (90+) are barely affected (~2% penalty), while coins with broken pegs
              are properly penalized (e.g. pegScore&nbsp;10 &rarr; 37% penalty). NAV tokens (pegScore&nbsp;=&nbsp;NR) receive
              multiplier&nbsp;1.0 since peg tracking does not apply to them.
            </p>
          </div>

          {/* No-liquidity penalty */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">No-Liquidity-Data Penalty</h3>
            <p>
              A further 0.9&times; multiplier is applied when a coin has no DEX liquidity score (NR).
              No free pass — as DEX liquidity coverage matures, the absence of liquidity data is
              increasingly suspicious. The 30% weight would normally be redistributed to other
              dimensions, effectively inflating the overall score; this multiplier corrects for that
              by applying a flat 10% penalty instead.
            </p>
          </div>

          {/* Resilience sub-factors */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Resilience Scoring</h3>
            <p>Average of three equally-weighted sub-factors (~33% each). Chain infrastructure is scored exclusively in the Decentralization dimension.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">Sub-factor</th>
                    <th className="py-2 pr-4 font-medium text-foreground">What it measures</th>
                    <th className="py-2 font-medium text-foreground">Scoring</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Collateral Quality</td>
                    <td className="py-2 pr-4">Reserve composition risk</td>
                    <td className="py-2">Weighted avg of curated reserve slices: Very&nbsp;Low&nbsp;(100), Low&nbsp;(75), Medium&nbsp;(50), High&nbsp;(25), Very&nbsp;High&nbsp;(5). Falls back to enum scoring for coins without curated reserves.</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Custody Model</td>
                    <td className="py-2 pr-4">Who holds the collateral?</td>
                    <td className="py-2">Fully&nbsp;on&#8209;chain&nbsp;(100), Institutional&nbsp;custodian&nbsp;(50), CEX/off&#8209;exchange&nbsp;(0)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Blacklist Capability</td>
                    <td className="py-2 pr-4">Can the issuer freeze holder funds?</td>
                    <td className="py-2">No&nbsp;(100), Possible&nbsp;(mutable&nbsp;contract)&nbsp;(66), Possible&nbsp;(inherited&nbsp;&mdash;&nbsp;&ge;25%&nbsp;of&nbsp;reserves&nbsp;backed&nbsp;by&nbsp;blacklistable&nbsp;coins&nbsp;such&nbsp;as&nbsp;USDC/USDT)&nbsp;(66), Yes&nbsp;(33)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              Collateral quality is derived from curated reserve compositions when available &mdash; each reserve slice is classified into one of five risk tiers and the score is their weighted average.
              For coins without curated reserves, a coarser enum-based fallback is used. Explicit overrides exist for coins where defaults are incorrect (e.g., protocols on Solana, coins with CEX custody).
            </p>
          </div>

          {/* Decentralization scoring */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Decentralization Scoring</h3>
            <p>Base score from governance quality tier, then a chain-risk penalty for protocols on less decentralized chains &mdash; governance decentralization is undermined when the underlying chain has centralisation concerns:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Immutable code</span> &mdash; 100 (no admin keys, no upgrade path &mdash; e.g.&nbsp;LUSD, BOLD). Exempt from chain-risk penalty</li>
              <li><span className="text-foreground">DAO governance</span> &mdash; 85 (e.g.&nbsp;DAI)</li>
              <li><span className="text-foreground">Multisig</span> &mdash; 55 (e.g.&nbsp;GHO, FRAX)</li>
              <li><span className="text-foreground">Regulated entity</span> &mdash; 40 (named regulator, license, and independent audit &mdash; e.g.&nbsp;USDC, USDT)</li>
              <li><span className="text-foreground">Single entity</span> &mdash; 20 (unregulated or unverified issuer)</li>
              <li><span className="text-foreground">Wrapper</span> &mdash; 10 (inherits upstream governance)</li>
            </ul>
            <p className="font-medium text-foreground mt-2">Chain-risk penalty (DAO, multisig, and wrapper governance &mdash; exempt for immutable-code, regulated-entity, single-entity):</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Ethereum &mdash; no penalty</li>
              <li>Stage 1+ L2 &mdash; &minus;15</li>
              <li>Established alt-L1 &mdash; &minus;50</li>
              <li>Unproven chain &mdash; &minus;65</li>
            </ul>
            <p className="text-xs">
              Example: hyUSD (DAO governance, Solana) = 85 &minus; 50 = <span className="text-foreground">35</span>.
              USDB (multisig, Blast L2) = 55 &minus; 15 = <span className="text-foreground">40</span>.
            </p>
          </div>

          {/* Dependency Risk scoring */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Dependency Risk Scoring</h3>
            <p>
              Two-phase computation ensures upstream scores are available before dependent coins are graded.
              Phase 1 grades independent coins (centralized &amp; decentralized), then Phase 2 grades CeFi-Dependent coins using Phase 1 results.
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Non-dependent coins</span> &mdash; score 95 (no upstream risk)</li>
              <li>
                <span className="text-foreground">With mapped dependencies</span> &mdash; blended score:
                each upstream&apos;s grade is weighted by its collateral fraction, and the self-backed portion (non-stablecoin collateral) scores vary by governance type
                (decentralized&nbsp;90, centralized-dependent&nbsp;75, centralized&nbsp;95).
                A &minus;10 penalty applies if any upstream dependency scores below 75
              </li>
              <li><span className="text-foreground">Unmapped dependencies</span> &mdash; falls back to 70 when dependencies aren&apos;t mapped or scores are unavailable</li>
            </ul>
            <p className="mt-2">
              <span className="text-foreground font-medium">Dependency type ceilings</span> &mdash; each dependency is classified as <em>wrapper</em>, <em>mechanism-critical</em>, or <em>collateral</em> (default).
              Wrappers (e.g., syrupUSDC &rarr; USDC) are thin layers around the upstream &mdash; their score is capped at <code className="text-xs">upstream &minus; 3</code>.
              Mechanism-critical dependencies (e.g., DAI &rarr; USDC via PSM) are essential to the peg &mdash; score is capped at the upstream&apos;s score.
              Collateral dependencies use the blended formula with no ceiling.
            </p>
            <p className="text-xs">
              Self-backed scores vary by governance type: centralized-dependent coins score 75 (systemic coupling risk), decentralized coins 90, and centralized coins 95. Centralized-dependent coins score lower because their peg mechanisms depend on upstream stablecoin infrastructure even for non-stablecoin collateral.
            </p>
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
                  <tr><td className="py-1.5 pr-8 text-foreground">A+</td><td className="py-1.5">87&ndash;100</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">A</td><td className="py-1.5">83&ndash;86</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">A&minus;</td><td className="py-1.5">80&ndash;82</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">B+</td><td className="py-1.5">75&ndash;79</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">B</td><td className="py-1.5">70&ndash;74</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">B&minus;</td><td className="py-1.5">65&ndash;69</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">C+</td><td className="py-1.5">60&ndash;64</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">C</td><td className="py-1.5">55&ndash;59</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">C&minus;</td><td className="py-1.5">50&ndash;54</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">D</td><td className="py-1.5">40&ndash;49</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">F</td><td className="py-1.5">0&ndash;39</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">NR</td><td className="py-1.5">Not enough data</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Key design decisions */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Key Design Decisions</h3>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground font-medium">NR (Not Rated)</span> is used when fewer than 2 base dimensions have data &mdash; no misleading partial grades</li>
              <li>Weight is redistributed proportionally among rated base dimensions when some are NR</li>
              <li>Peg stability acts as a multiplier, not a base dimension &mdash; maintaining a peg is table stakes, not a differentiator</li>
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
            </ul>
          </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* Liquidity Score */}
      <Card id="liquidity-methodology" className="scroll-mt-28 rounded-xl border-l-[3px] border-l-cyan-500">
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Liquidity Score</CardTitle>
            <span className="inline-flex items-center rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-cyan-500">
              {LIQUIDITY_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link href="/methodology/liquidity-score-changelog" className="text-xs text-foreground underline underline-offset-4 hover:text-cyan-500 transition-colors">
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when liquidity formula weights, source inclusion rules, or TVL normalization logic changes.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Composite 0&ndash;100 score measuring DEX liquidity depth per stablecoin, updated every 30 minutes.
            Aggregates pool data across all major DEXes and chains.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Update cadence</p>
              <p className="text-foreground">30m refresh</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Signal mix</p>
              <p className="text-foreground">6 weighted liquidity components</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Output</p>
              <p className="text-foreground">0-100 DEX depth score</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                { label: "Minimum data", value: "No hard minimum in scorer; missing stability history defaults to neutral 50 sub-scores" },
                { label: "Required sources", value: "Pool TVL/volume/chain data plus mechanism and pair-quality metadata" },
                { label: "Failure behavior", value: "If liquidity score is null/missing, report-card liquidity dimension is NR" },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against computeLiquidityScore)">
            <p className="font-mono">
              Inputs: effectiveTVL=$25M, TVL=$20M, volume24h=$8M, qualityTVL=$18M, durability=68, pools=12, chains=4
            </p>
            <p className="font-mono">
              tvlDepth=67.96, volume=80, quality=65.11, pair=60, crossChain=51
            </p>
            <p className="font-mono">
              score=round(0.30*67.96+0.20*80+0.20*65.11+0.15*68+0.075*60+0.075*51)=68
            </p>
            <p>Result: <span className="text-foreground">Liquidity score 68</span>.</p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: component weights, TVL scaling, and quality adjustments">

          {/* Liquidity component diagram — desktop: 3×2 grid */}
          <div className="hidden md:flex flex-col items-center gap-3">
            <div className="grid grid-cols-3 gap-3 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">TVL Depth</p>
                <p className="text-xs text-muted-foreground mt-0.5">30%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Volume Activity</p>
                <p className="text-xs text-muted-foreground mt-0.5">20%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Pool Quality</p>
                <p className="text-xs text-muted-foreground mt-0.5">20%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Durability</p>
                <p className="text-xs text-muted-foreground mt-0.5">15%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Pair Diversity</p>
                <p className="text-xs text-muted-foreground mt-0.5">7.5%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Cross-chain</p>
                <p className="text-xs text-muted-foreground mt-0.5">7.5%</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border p-3 text-center w-64">
              <p className="text-foreground font-medium">Liquidity Score</p>
              <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
            </div>
          </div>

          {/* Liquidity component diagram — mobile: 2-col grid */}
          <div className="flex flex-col items-center gap-3 md:hidden">
            <div className="grid grid-cols-2 gap-2 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">TVL Depth</p>
                <p className="text-xs text-muted-foreground">30%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Vol. Activity</p>
                <p className="text-xs text-muted-foreground">20%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Pool Quality</p>
                <p className="text-xs text-muted-foreground">20%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Durability</p>
                <p className="text-xs text-muted-foreground">15%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Pair Diversity</p>
                <p className="text-xs text-muted-foreground">7.5%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Cross-chain</p>
                <p className="text-xs text-muted-foreground">7.5%</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Liquidity Score</p>
              <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
            </div>
          </div>

          {/* Components */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Components</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">Component</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Weight</th>
                    <th className="py-2 font-medium text-foreground">How it works</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr>
                    <td className="py-2 pr-4 text-foreground">TVL Depth</td>
                    <td className="py-2 pr-4">30%</td>
                    <td className="py-2">Log-scale effective TVL (quality-adjusted, metapool-deduped): $100K&rarr;20, $1M&rarr;40, $10M&rarr;60, $100M&rarr;80, $1B+&rarr;100</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Volume Activity</td>
                    <td className="py-2 pr-4">20%</td>
                    <td className="py-2">Volume/TVL ratio. 0&rarr;0, 0.5+&rarr;100</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Pool Quality</td>
                    <td className="py-2 pr-4">20%</td>
                    <td className="py-2">Quality-adjusted TVL using pool mechanism multiplier &times; balance health &times; pair quality. Curve StableSwap (A&ge;500) = 1.0&times;, Uni V3 1bp = 1.1&times;, generic AMM = 0.3&times;</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Durability</td>
                    <td className="py-2 pr-4">15%</td>
                    <td className="py-2">Organic fee fraction (35%), TVL stability (25%), volume consistency (20%), pool maturity (15%), locked liquidity (5%)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Pair Diversity</td>
                    <td className="py-2 pr-4">7.5%</td>
                    <td className="py-2">Pool count with diminishing returns: min(100, poolCount &times; 5)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Cross-chain</td>
                    <td className="py-2 pr-4">7.5%</td>
                    <td className="py-2">Number of chains with liquidity: 1&rarr;15, then +12 per chain, capped at 100 (e.g. 2&rarr;27, 5&rarr;63, 9+&rarr;100)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Quality multipliers */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Pool Quality Adjustments</h3>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Balance health</span> &mdash; continuous ratio (not binary threshold): pools with imbalanced reserves score lower</li>
              <li><span className="text-foreground">Pair quality</span> &mdash; co-token scored by Pharos governance classification (CeFi&rarr;1.0, DeFi&rarr;0.9, CeFi-Dep&rarr;0.8) plus static map for volatile assets (WETH&rarr;0.65, WBTC&rarr;0.6)</li>
              <li><span className="text-foreground">Metapool dedup</span> &mdash; uses TVL excluding base pool to prevent double-counting across Curve metapools</li>
            </ul>
          </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* Mint/Burn Flow Scoring */}
      <Card id="mint-burn-flow-methodology" className="scroll-mt-28 rounded-xl border-l-[3px] border-l-orange-500">
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Mint/Burn Flow Scoring</CardTitle>
            <span className="inline-flex items-center rounded-md border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-orange-500">
              {MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link href={MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH} className="text-xs text-foreground underline underline-offset-4 hover:text-orange-500 transition-colors">
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when flow scoring logic, tracked event semantics, or ingestion attribution policies change.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Pharos tracks on-chain mint and burn events for major stablecoins via Alchemy JSON-RPC (Transfer mints/burns
            plus USDT Issue/Redeem). These raw events are aggregated into hourly buckets and scored to detect abnormal flow
            patterns that may signal market stress or capital rotation.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Data source</p>
              <p className="text-foreground">On-chain mint + burn events</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Primary score</p>
              <p className="text-foreground">FIS (-100 to +100)</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Main outputs</p>
              <p className="text-foreground">Bank-run gauge + FtQ signal</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                { label: "Minimum data", value: "FIS requires at least 7 days of flow history per coin" },
                { label: "Required sources", value: "24h mint/burn totals plus 30-day baseline aggregates" },
                { label: "Failure behavior", value: "FIS can be null; gauge is null when no weighted inputs contribute; FtQ needs ±$100M dual threshold" },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against computeFlowIntensity)">
            <p className="font-mono">
              Inputs: currentNet=-$220M, baselineNet=-$40M, baselineAbs=$500M
            </p>
            <p className="font-mono">
              denominator=max(500M*0.3,1M)=150M; z=(-220M-(-40M))/150M=-1.2
            </p>
            <p className="font-mono">
              FIS=clamp(-100,100,z*50)=-60
            </p>
            <p>Result: <span className="text-foreground">FIS -60 (STRESS band)</span>.</p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: bucket pipeline, FIS formula, and threshold bands">

          {/* Flow pipeline diagram — desktop: horizontal */}
          <div className="hidden md:flex items-stretch gap-4">
            {/* Inputs */}
            <div className="flex flex-col gap-2 flex-1">
              <div className="rounded-lg border p-3 text-center flex-1">
                <p className="text-foreground font-medium">Mints</p>
                <p className="text-xs text-muted-foreground mt-0.5">Transfer from 0x0</p>
              </div>
              <div className="rounded-lg border p-3 text-center flex-1">
                <p className="text-foreground font-medium">Burns</p>
                <p className="text-xs text-muted-foreground mt-0.5">Transfer to 0x0</p>
              </div>
            </div>
            <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
            {/* Aggregation */}
            <div className="rounded-lg border p-3 text-center flex-1 flex flex-col justify-center">
              <p className="text-foreground font-medium">Hourly Buckets</p>
              <p className="text-xs text-muted-foreground mt-0.5">30-day rolling baseline</p>
            </div>
            <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
            {/* FIS */}
            <div className="rounded-lg border p-3 text-center flex-1 flex flex-col justify-center">
              <p className="text-foreground font-medium">Flow Intensity Score</p>
              <p className="text-xs text-muted-foreground mt-0.5">-100 (max burn) · 0 (neutral) · +100 (max mint)</p>
            </div>
            <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
            {/* Outputs */}
            <div className="flex flex-col gap-2 flex-1">
              <div className="rounded-lg border p-3 text-center flex-1">
                <p className="text-foreground font-medium">Bank Run Gauge</p>
                <p className="text-xs text-muted-foreground mt-0.5">market-cap weighted</p>
              </div>
              <div className="rounded-lg border p-3 text-center flex-1">
                <p className="text-foreground font-medium">Flight-to-Quality</p>
                <p className="text-xs text-muted-foreground mt-0.5">dual threshold detection</p>
              </div>
            </div>
          </div>

          {/* Flow pipeline diagram — mobile: vertical */}
          <div className="flex flex-col items-center gap-3 md:hidden">
            <div className="grid grid-cols-2 gap-2 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Mints</p>
                <p className="text-xs text-muted-foreground">Transfer from 0x0</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Burns</p>
                <p className="text-xs text-muted-foreground">Transfer to 0x0</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Hourly Buckets</p>
              <p className="text-xs text-muted-foreground mt-0.5">30-day rolling baseline</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Flow Intensity Score</p>
              <p className="text-xs text-muted-foreground mt-0.5">-100 (max burn) · 0 (neutral) · +100 (max mint)</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="grid grid-cols-2 gap-2 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Bank Run Gauge</p>
                <p className="text-xs text-muted-foreground">market-cap weighted</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Flight-to-Quality</p>
                <p className="text-xs text-muted-foreground">dual threshold</p>
              </div>
            </div>
          </div>

          {/* Flow Intensity Score */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Flow Intensity Score (FIS)</h3>
            <p>
              Per-coin score measuring how far current mint/burn activity deviates from its historical baseline.
              Ranges from -100 (extreme net burning) to +100 (extreme net minting), with 0 representing normal activity.
            </p>
            <p className="font-mono text-xs bg-muted rounded px-3 py-2">
              denominator = max(baselineDailyAbs &times; 0.3, $1M)<br />
              z = (currentDailyNet &minus; baselineDailyNet) / denominator<br />
              FIS = clamp(-100, 100, z &times; 50)
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Baseline period</span> &mdash; 30-day rolling average of daily net flows and absolute volumes</li>
              <li><span className="text-foreground">Minimum data</span> &mdash; requires 7 days of history; returns null (NR) otherwise</li>
              <li><span className="text-foreground">Activity gate</span> &mdash; windows with no 24h mint/burn activity are marked NR and excluded from gauge weighting</li>
              <li><span className="text-foreground">Floor</span> &mdash; denominator is floored at $1M to prevent noise in low-volume coins</li>
              <li><span className="text-foreground">Interpretation</span> &mdash; FIS &lt; -40 = significant net burning, FIS &gt; 40 = significant net minting</li>
            </ul>
          </div>

          {/* Bank Run Gauge */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Bank Run Gauge</h3>
            <p>
              Market-cap-weighted composite of all tracked coins&apos; FIS values, producing a single ecosystem-wide
              reading. The gauge score maps to one of seven condition bands:
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">Band</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Score Range</th>
                    <th className="py-2 font-medium text-foreground">Meaning</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr><td className="py-1.5 pr-4 text-foreground">CRISIS</td><td className="py-1.5 pr-4">&minus;100 to &minus;70</td><td className="py-1.5">Severe coordinated burning across major coins</td></tr>
                  <tr><td className="py-1.5 pr-4 text-foreground">STRESS</td><td className="py-1.5 pr-4">&minus;70 to &minus;40</td><td className="py-1.5">Significant net outflows from the ecosystem</td></tr>
                  <tr><td className="py-1.5 pr-4 text-foreground">CAUTIOUS</td><td className="py-1.5 pr-4">&minus;40 to &minus;10</td><td className="py-1.5">Mild net burning, elevated caution</td></tr>
                  <tr><td className="py-1.5 pr-4 text-foreground">NEUTRAL</td><td className="py-1.5 pr-4">&minus;10 to 10</td><td className="py-1.5">Normal activity, balanced mints and burns</td></tr>
                  <tr><td className="py-1.5 pr-4 text-foreground">HEALTHY</td><td className="py-1.5 pr-4">10 to 40</td><td className="py-1.5">Moderate net inflows</td></tr>
                  <tr><td className="py-1.5 pr-4 text-foreground">CONFIDENT</td><td className="py-1.5 pr-4">40 to 70</td><td className="py-1.5">Strong net minting, capital entering the ecosystem</td></tr>
                  <tr><td className="py-1.5 pr-4 text-foreground">SURGE</td><td className="py-1.5 pr-4">70 to 100</td><td className="py-1.5">Exceptional minting activity across the market</td></tr>
                </tbody>
              </table>
            </div>
            <p>
              Returns null only when all tracked coins are NR (for example, insufficient history or no 24h mint/burn activity).
              Coins with null FIS are skipped from the market-cap-weighted composite.
            </p>
          </div>

          {/* Flight-to-quality */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Flight-to-Quality Detection</h3>
            <p>
              Detects capital rotation from risky to safe-haven stablecoins &mdash; a pattern typically seen during
              market stress when holders move funds from algorithmic or less-established coins into fully-backed
              centralized stablecoins.
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Safe classification</span> &mdash; centralized governance with real-world-asset backing (USDT, USDC, FDUSD, PYUSD)</li>
              <li><span className="text-foreground">Dual threshold</span> &mdash; active when risky coins have &gt;$100M net outflows AND safe coins have &gt;$100M net inflows simultaneously over 24h</li>
              <li><span className="text-foreground">Intensity scaling</span> &mdash; min(100, |riskyOutflows| / $1B &times; 100), reflecting the magnitude of the rotation</li>
            </ul>
          </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* Yield Intelligence */}
      <Card id="yield-intelligence-methodology" className="scroll-mt-28 rounded-xl border-l-[3px] border-l-violet-500">
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Yield Intelligence</CardTitle>
            <span className="inline-flex items-center rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-violet-500">
              {YIELD_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link href={YIELD_METHODOLOGY_CHANGELOG_PATH} className="text-xs text-foreground underline underline-offset-4 hover:text-violet-500 transition-colors">
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when APY source resolution, PYS scoring logic, or eligibility rules for discovered yield sources change.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Pharos tracks yield-bearing stablecoins and computes a risk-adjusted ranking via the
            Pharos Yield Score (PYS). Data is refreshed every 30 minutes using a three-tier APY
            resolution strategy.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Update cadence</p>
              <p className="text-foreground">30m refresh</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">APY priority</p>
              <p className="text-foreground">On-chain, then DeFiLlama, then price</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Output</p>
              <p className="text-foreground">PYS (0-100)</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                { label: "Minimum data", value: "Need one resolved APY tier; Tier 1 additionally needs a prior exchange-rate history point" },
                { label: "Required sources", value: "On-chain rates or DeFiLlama pools; Tier 3 needs current and ~30d-old prices" },
                { label: "Failure behavior", value: "No resolved tier skips coin update; PYS returns 0 when apy30d <= 0 (safety defaults to 40 if missing)" },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against computePYS)">
            <p className="font-mono">
              Inputs: apy30d=8.4, safetyScore=72, apyVarianceScore=0.18, scalingFactor=5
            </p>
            <p className="font-mono">
              riskPenalty=max(0.5,(101-72)/20)=1.45; yieldEfficiency=8.4/1.45=5.79; sustainability=1-0.18=0.82
            </p>
            <p className="font-mono">
              PYS=min(100, round(5.79*0.82*5))=24
            </p>
            <p>Result: <span className="text-foreground">PYS 24</span>.</p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: APY tier resolution, PYS formula, NAV handling, and limits">

          {/* Yield pipeline diagram — desktop: horizontal */}
          <div className="hidden md:flex items-stretch gap-4">
            {/* Three tiers */}
            <div className="flex flex-col gap-2 flex-1">
              <div className="rounded-lg border p-3 text-center flex-1">
                <p className="text-foreground font-medium">Tier 1</p>
                <p className="text-xs text-muted-foreground mt-0.5">On-chain exchange rate</p>
              </div>
              <div className="rounded-lg border p-3 text-center flex-1">
                <p className="text-foreground font-medium">Tier 2</p>
                <p className="text-xs text-muted-foreground mt-0.5">DeFiLlama pools</p>
              </div>
              <div className="rounded-lg border p-3 text-center flex-1">
                <p className="text-foreground font-medium">Tier 3</p>
                <p className="text-xs text-muted-foreground mt-0.5">Price-derived (NAV)</p>
              </div>
            </div>
            <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
            {/* APY */}
            <div className="rounded-lg border p-3 text-center w-32 flex flex-col justify-center flex-shrink-0">
              <p className="text-foreground font-medium">APY</p>
              <p className="text-xs text-muted-foreground mt-0.5">first successful tier</p>
            </div>
            <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
            {/* Formula components */}
            <div className="flex flex-col gap-2 flex-1">
              <div className="rounded-lg border p-3 text-center flex-1">
                <p className="text-foreground font-medium">Yield Efficiency</p>
                <p className="text-xs text-muted-foreground mt-0.5">APY ÷ risk penalty</p>
              </div>
              <div className="rounded-lg border p-3 text-center flex-1">
                <p className="text-foreground font-medium">Sustainability</p>
                <p className="text-xs text-muted-foreground mt-0.5">penalises high variance</p>
              </div>
            </div>
            <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
            {/* PYS */}
            <div className="rounded-lg border p-3 text-center w-32 flex flex-col justify-center flex-shrink-0">
              <p className="text-foreground font-medium">PYS Score</p>
              <p className="text-xs text-muted-foreground mt-0.5">0–100</p>
            </div>
          </div>

          {/* Yield pipeline diagram — mobile: vertical */}
          <div className="flex flex-col items-center gap-3 md:hidden">
            <div className="grid grid-cols-3 gap-2 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Tier 1</p>
                <p className="text-xs text-muted-foreground">On-chain rate</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Tier 2</p>
                <p className="text-xs text-muted-foreground">DeFiLlama</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Tier 3</p>
                <p className="text-xs text-muted-foreground">Price-derived</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">APY</p>
              <p className="text-xs text-muted-foreground mt-0.5">first successful tier</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="grid grid-cols-2 gap-2 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Yield Efficiency</p>
                <p className="text-xs text-muted-foreground">APY ÷ risk penalty</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Sustainability</p>
                <p className="text-xs text-muted-foreground">penalises variance</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">PYS Score</p>
              <p className="text-xs text-muted-foreground mt-0.5">0–100</p>
            </div>
          </div>

          {/* APY Resolution tiers */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">APY Resolution (three-tier)</h3>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Tier 1 &mdash; On-chain exchange rate</span>: reads the token contract directly (e.g.&nbsp;sDAI, sUSDe) and computes APY from the 7-day rate delta</li>
              <li><span className="text-foreground">Tier 2 &mdash; DeFiLlama pools</span>: matches the coin to a DeFiLlama yield pool via static mapping or symbol-based fallback</li>
              <li><span className="text-foreground">Tier 3 &mdash; Price-derived</span>: for NAV tokens only, derives APY from the 30-day price appreciation in supply_history</li>
            </ul>
            <p>Each tier is tried in order; the first successful resolution is used.</p>
          </div>

          {/* PYS formula */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Pharos Yield Score (PYS)</h3>
            <p className="font-mono text-xs bg-muted rounded px-3 py-2">
              riskPenalty = max(0.5, (101 &minus; safetyScore) / 20)<br />
              yieldEfficiency = apy30d / riskPenalty<br />
              sustainability = max(0.3, 1.0 &minus; apyVarianceScore)<br />
              PYS = min(100, yieldEfficiency &times; sustainability &times; scalingFactor)
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Yield efficiency</span> rewards higher APY relative to the coin&apos;s risk profile &mdash; safer coins get a lower penalty divisor</li>
              <li><span className="text-foreground">Sustainability multiplier</span> penalizes volatile yields (high variance over 30 days), favouring consistent returns</li>
              <li><span className="text-foreground">Scaling factor</span> is a global constant that normalises scores into the 0&ndash;100 range</li>
            </ul>
          </div>

          {/* NAV token note */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">NAV Token Handling</h3>
            <p>
              NAV-appreciating tokens (e.g.&nbsp;sDAI, wUSDM, BUIDL) are not covered by the report card
              framework&apos;s safety grading &mdash; they receive a default safety baseline of 40 (NR).
              Their PYS is therefore derived primarily from APY magnitude and variance rather than a
              full safety assessment. As the grading framework expands to cover NAV tokens, their PYS
              will become more nuanced.
            </p>
          </div>

          {/* Limitations */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Limitations</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>Trailing averages require sufficient history &mdash; newly tracked coins may show unstable scores until 30 days of data accumulate</li>
              <li>DeFiLlama pool matching uses heuristics; pool mismatches are corrected via the static override map</li>
              <li>Price-derived APY (Tier 3) can be noisy for low-liquidity NAV tokens</li>
            </ul>
          </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* PegScore and Depeg Early Warning Score (DEWS) */}
      <Card id="pegscore-dews-methodology" className="scroll-mt-28 rounded-xl border-l-[3px] border-l-amber-500">
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">PegScore and Depeg Early Warning Score (DEWS)</CardTitle>
            <span className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-amber-500">
              {DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link href={DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH} className="text-xs text-foreground underline underline-offset-4 hover:text-amber-500 transition-colors">
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when depeg thresholds, confirmation policy, peg-score formula terms, or DEWS signal composition changes.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            PegScore observes the past and present by scoring realized peg behavior, while DEWS is
            forward-looking and tries to anticipate future depeg risk before it fully manifests.
          </p>
          <p>
            Depeg Tracker combines live event detection, secondary-source confirmation rules for large-cap assets,
            and a per-coin peg score that penalizes time off peg, event severity, active depegs, and unstable event spread.
          </p>
          <p>
            DEWS (Depeg Early Warning System) computes forward-looking stress every 15 minutes from market, liquidity,
            confidence, flow, and yield signals, with optional PSI-based amplification during systemic stress.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">PegScore focus</p>
              <p className="text-foreground">History: realized peg behavior</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">DEWS focus</p>
              <p className="text-foreground">Forward stress probability</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Refresh</p>
              <p className="text-foreground">15m refresh</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                { label: "Minimum data", value: "PegScore requires >=30 tracking days; DEWS requires >=2 available signals (total weight >=0.30)" },
                { label: "Required sources", value: "Peg events + tracking window inputs; DEWS consumes supply/liquidity/price plus optional flow/blacklist/yield signals" },
                { label: "Failure behavior", value: "PegScore can be null; DEWS returns 0 (CALM) when signal coverage is below threshold" },
              ]}
            />
          </div>
          <WorkedExample summary="Worked examples (verified against computePegScore and computeDEWS)">
            <p className="font-mono">
              PegScore input: 100-day tracking window, 1 event (2 days, 220 bps, inactive)
            </p>
            <p className="font-mono">
              pegPct=98.0, severityScore=99.86, spread=0, activePenalty=0 &rarr; pegScore=99
            </p>
            <p className="font-mono">
              DEWS input signals: supply=40, pool=55, liq=25, price=0, diverg=10 (others unavailable), psiScore=70
            </p>
            <p className="font-mono">
              base=(0.25*40+0.2*55+0.15*25+0.15*0+0.15*10)/0.9=29.17; PSI amplifier=1.02 &rarr; DEWS=30
            </p>
            <p>Result: <span className="text-foreground">PegScore 99 and DEWS 30 (WATCH)</span>.</p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: PegScore formula, DEWS signals, weights, and threat bands">

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">PegScore</h3>
            <p>
              Composite 0&ndash;100 score measuring how faithfully a stablecoin holds its peg.
              The tracking window spans up to 4 years but is capped at the coin&apos;s actual age (earliest supply snapshot),
              so young coins are not diluted across history they didn&apos;t exist for.
              Requires at least 30 days of tracking data; returns null otherwise.
            </p>
          </div>

          {/* Peg score formula */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">PegScore Formula</h3>
            <p className="font-mono text-xs bg-muted rounded px-3 py-2">
              pegScore = 0.5 &times; pegPct + 0.5 &times; severityScore &minus; activeDepegPenalty &minus; spreadPenalty
            </p>
          </div>

          {/* Peg score flow diagram — desktop */}
          <div className="hidden md:flex flex-col items-center gap-3">
            <div className="grid grid-cols-2 gap-3 w-full max-w-md">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Time-at-Peg</p>
                <p className="text-xs text-muted-foreground mt-0.5">50%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Event Severity</p>
                <p className="text-xs text-muted-foreground mt-0.5">50%</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border p-3 text-center w-64">
              <p className="text-foreground font-medium">&minus; Penalties</p>
              <p className="text-xs text-muted-foreground mt-0.5">active depeg + spread</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border p-3 text-center w-64">
              <p className="text-foreground font-medium">PegScore</p>
              <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
            </div>
          </div>

          {/* Peg score flow diagram — mobile */}
          <div className="flex flex-col items-center gap-3 md:hidden">
            <div className="grid grid-cols-2 gap-2 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Time-at-Peg</p>
                <p className="text-xs text-muted-foreground">50%</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Event Severity</p>
                <p className="text-xs text-muted-foreground">50%</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">&minus; Penalties</p>
              <p className="text-xs text-muted-foreground mt-0.5">active depeg + spread</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">PegScore</p>
              <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
            </div>
          </div>

          {/* Peg score components */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">PegScore Components</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">Component</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Weight</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Range</th>
                    <th className="py-2 font-medium text-foreground">How it works</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Time-at-Peg (pegPct)</td>
                    <td className="py-2 pr-4">50%</td>
                    <td className="py-2 pr-4">0&ndash;100</td>
                    <td className="py-2">Percentage of time spent at peg. Overlapping depeg intervals are merged to avoid double-counting</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Event Severity</td>
                    <td className="py-2 pr-4">50%</td>
                    <td className="py-2 pr-4">0&ndash;100</td>
                    <td className="py-2">
                      Penalizes magnitude, duration, and recency of each depeg event.
                      Per-event penalty: max(durationPenalty, magnitudeFloor), where
                      durationPenalty = (peakBps&nbsp;/&nbsp;100) &times; (durationDays&nbsp;/&nbsp;30) &times; recencyWeight,
                      magnitudeFloor = (peakBps&nbsp;/&nbsp;2000) &times; recencyWeight.
                      The floor ensures even brief depegs carry a minimum penalty proportional to their severity.
                      Recency weight = 1&nbsp;/&nbsp;(1&nbsp;+&nbsp;yearsAgo) so recent events count more. Duration capped at 90 days
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Active Depeg Penalty</td>
                    <td className="py-2 pr-4">subtracted</td>
                    <td className="py-2 pr-4">5&ndash;50</td>
                    <td className="py-2">Applied only if an ongoing depeg exists (no end date). Scales with severity: clamp(absBps&nbsp;/&nbsp;50, 5, 50)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Spread Penalty</td>
                    <td className="py-2 pr-4">subtracted</td>
                    <td className="py-2 pr-4">0&ndash;15</td>
                    <td className="py-2">Standard deviation of peak deviations across events, scaled. Penalizes erratic, unpredictable depeg behaviour. Only applies when &ge;2 events exist</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">DEWS</h3>
            <p>
              DEWS is a per-coin, forward-looking stress score (0&ndash;100) estimating depeg probability.
              It is computed every 15 minutes from 8 sub-signals. Only signals with available data
              participate; weights are redistributed proportionally across available signals.
            </p>
          </div>

          {/* DEWS pipeline diagram — desktop: horizontal */}
          <div className="hidden md:flex items-stretch gap-4">
            {/* 8 signals */}
            <div className="grid grid-cols-2 gap-2 flex-1">
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Supply Velocity</p>
                <p className="text-xs text-muted-foreground">0.25</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Pool Balance Drift</p>
                <p className="text-xs text-muted-foreground">0.20</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Liquidity Erosion</p>
                <p className="text-xs text-muted-foreground">0.15</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Price Confidence</p>
                <p className="text-xs text-muted-foreground">0.15</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Cross-Source Divergence</p>
                <p className="text-xs text-muted-foreground">0.15</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Blacklist Activity</p>
                <p className="text-xs text-muted-foreground">0.10</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Mint/Burn Flow</p>
                <p className="text-xs text-muted-foreground">0.10</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Yield Anomaly</p>
                <p className="text-xs text-muted-foreground">0.05</p>
              </div>
            </div>
            <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
            {/* DEWS */}
            <div className="rounded-lg border p-3 text-center w-36 flex flex-col justify-center flex-shrink-0">
              <p className="text-foreground font-medium">DEWS</p>
              <p className="text-xs text-muted-foreground mt-0.5">&Sigma;(W&sdot;S) / &Sigma;(W)</p>
              <p className="text-xs text-muted-foreground">0–100</p>
            </div>
            <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
            {/* Threat bands */}
            <div className="flex flex-col gap-1.5 w-36 justify-center flex-shrink-0">
              <div className="rounded-lg border p-2 text-center">
                <p className="text-green-500 font-medium text-xs">CALM</p>
                <p className="text-xs text-muted-foreground">0–15</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-teal-500 font-medium text-xs">WATCH</p>
                <p className="text-xs text-muted-foreground">16–35</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-yellow-500 font-medium text-xs">ALERT</p>
                <p className="text-xs text-muted-foreground">36–55</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-orange-500 font-medium text-xs">WARNING</p>
                <p className="text-xs text-muted-foreground">56–75</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-red-500 font-medium text-xs">DANGER</p>
                <p className="text-xs text-muted-foreground">76–100</p>
              </div>
            </div>
          </div>

          {/* DEWS pipeline diagram — mobile: vertical */}
          <div className="flex flex-col items-center gap-3 md:hidden">
            <div className="grid grid-cols-2 gap-2 w-full">
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Supply Velocity</p>
                <p className="text-xs text-muted-foreground">0.25</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Pool Balance Drift</p>
                <p className="text-xs text-muted-foreground">0.20</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Liquidity Erosion</p>
                <p className="text-xs text-muted-foreground">0.15</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Price Confidence</p>
                <p className="text-xs text-muted-foreground">0.15</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Cross-Source Div.</p>
                <p className="text-xs text-muted-foreground">0.15</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Blacklist Activity</p>
                <p className="text-xs text-muted-foreground">0.10</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Mint/Burn Flow</p>
                <p className="text-xs text-muted-foreground">0.10</p>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <p className="text-foreground font-medium text-xs">Yield Anomaly</p>
                <p className="text-xs text-muted-foreground">0.05</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">DEWS</p>
              <p className="text-xs text-muted-foreground mt-0.5">&Sigma;(W&sdot;S) / &Sigma;(W) &mdash; 0–100</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="grid grid-cols-5 gap-1 w-full">
              <div className="rounded-lg border p-1.5 text-center">
                <p className="text-green-500 font-medium text-xs">CALM</p>
                <p className="text-xs text-muted-foreground">0–15</p>
              </div>
              <div className="rounded-lg border p-1.5 text-center">
                <p className="text-teal-500 font-medium text-xs">WATCH</p>
                <p className="text-xs text-muted-foreground">16–35</p>
              </div>
              <div className="rounded-lg border p-1.5 text-center">
                <p className="text-yellow-500 font-medium text-xs">ALERT</p>
                <p className="text-xs text-muted-foreground">36–55</p>
              </div>
              <div className="rounded-lg border p-1.5 text-center">
                <p className="text-orange-500 font-medium text-xs">WARN</p>
                <p className="text-xs text-muted-foreground">56–75</p>
              </div>
              <div className="rounded-lg border p-1.5 text-center">
                <p className="text-red-500 font-medium text-xs">DANGER</p>
                <p className="text-xs text-muted-foreground">76–100</p>
              </div>
            </div>
          </div>

          {/* Formula */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Score Formula</h3>
            <p className="font-mono text-xs bg-muted rounded px-3 py-2">
              DEWS = round(clamp(0, 100, sum(W_i &times; S_i) / sum(W_i)))
            </p>
            <p>At least 2 available signal sources (total weight &ge; 0.30) are required to produce a non-zero score.</p>
          </div>

          {/* Sub-signals */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Sub-Signals &amp; Weights</h3>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Supply Velocity (0.25)</span> &mdash; rapid redemptions (bank run), measured from 1-day and 7-day supply contraction rates</li>
              <li><span className="text-foreground">Pool Balance Drift (0.20)</span> &mdash; one-sided selling pressure in DEX pools, blending balance stress, pool stress, and worst-pool imbalance</li>
              <li><span className="text-foreground">Liquidity Erosion (0.15)</span> &mdash; LPs fleeing, measured from 7-day changes in liquidity score and TVL</li>
              <li><span className="text-foreground">Price Confidence (0.15)</span> &mdash; oracle/data source failures, mapping confidence levels to stress values</li>
              <li><span className="text-foreground">Cross-Source Divergence (0.15)</span> &mdash; fragmented pricing between primary price, DEX price, and peg reference</li>
              <li><span className="text-foreground">Blacklist Activity (0.10)</span> &mdash; issuer emergency freeze surges for USDC, USDT, PAXG, XAUT</li>
              <li><span className="text-foreground">Mint/Burn Flow (0.10)</span> &mdash; redemption surge vs minting from on-chain Transfer event data</li>
              <li><span className="text-foreground">Yield Anomaly (0.05)</span> &mdash; warning-signal accumulation from yield spikes, divergence, TVL outflows, negative trends, and reward-heavy regimes</li>
            </ul>
          </div>

          {/* Threat bands */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Threat Bands</h3>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-green-500 font-medium">CALM (0&ndash;15)</span> &mdash; no stress signals detected</li>
              <li><span className="text-teal-500 font-medium">WATCH (16&ndash;35)</span> &mdash; mild stress on 1&ndash;2 indicators</li>
              <li><span className="text-yellow-500 font-medium">ALERT (36&ndash;55)</span> &mdash; multiple indicators elevated</li>
              <li><span className="text-orange-500 font-medium">WARNING (56&ndash;75)</span> &mdash; strong stress signals, depeg plausible</li>
              <li><span className="text-red-500 font-medium">DANGER (76&ndash;100)</span> &mdash; all precursors firing</li>
            </ul>
          </div>

          {/* Edge cases */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Edge Cases</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>NAV tokens are excluded entirely (price appreciates, not pegged)</li>
              <li>Non-USD pegs: cross-source divergence is dampened by 0.7 (noisier FX pricing)</li>
              <li>Small coins (&lt;$50M): supply velocity is dampened via a logarithmic size factor</li>
              <li>Missing DEX data: pool and liquidity signals marked unavailable, weight redistributed</li>
            </ul>
          </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* Contagion Stress Test */}
      <Card id="contagion-stress-test-methodology" className="scroll-mt-28 rounded-xl border-l-[3px] border-l-emerald-500">
        <CardHeader>
          <CardTitle as="h2">Contagion Stress Test</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            The stress test simulates dependency failures to reveal systemic concentration risk
            across the stablecoin ecosystem.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Simulation action</p>
              <p className="text-foreground">Force one coin to grade D</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Propagation channel</p>
              <p className="text-foreground">Dependency channel only</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Primary output</p>
              <p className="text-foreground">Affected coins + supply at risk</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                { label: "Minimum data", value: "Target coin must have dependents and mapped dependency weights" },
                { label: "Required sources", value: "Current report-card scores plus dependency map inputs" },
                { label: "Failure behavior", value: "Only direct dependency-risk channel is recomputed (no peg/liquidity/confidence feedback loops)" },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against scoreDependencyRisk path used by stress test)">
            <p className="font-mono">
              Override upstream score to 40; dependent coin has 60% exposure and decentralized self-backed score 90
            </p>
            <p className="font-mono">
              blended=0.6*40+0.4*90=60; weak-upstream penalty (score&lt;75) applies -10
            </p>
            <p className="font-mono">
              dependencyRisk score=50
            </p>
            <p>Result: <span className="text-foreground">Dependency dimension falls to 50 before overall grade recomputation</span>.</p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: simulation pipeline, scoreboard logic, and limitations">

          {/* Stress test pipeline diagram — desktop: horizontal */}
          <div className="hidden md:grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-4 items-start">
            <div className="rounded-lg border p-3 text-center self-center">
              <p className="text-foreground font-medium">Select Target</p>
              <p className="text-xs text-muted-foreground mt-0.5">pick a coin</p>
            </div>
            <div className="flex items-center self-center text-muted-foreground text-xl font-bold">&rarr;</div>
            <div className="rounded-lg border p-3 text-center self-center">
              <p className="text-foreground font-medium">Override to D</p>
              <p className="text-xs text-muted-foreground mt-0.5">force downgrade</p>
            </div>
            <div className="flex items-center self-center text-muted-foreground text-xl font-bold">&rarr;</div>
            <div className="rounded-lg border p-3 text-center self-center">
              <p className="text-foreground font-medium">Recompute Dep. Risk</p>
              <p className="text-xs text-muted-foreground mt-0.5">cascade upstream</p>
            </div>
            <div className="flex items-center self-center text-muted-foreground text-xl font-bold">&rarr;</div>
            <div className="rounded-lg border p-3 text-center self-center">
              <p className="text-foreground font-medium">Impact Report</p>
              <p className="text-xs text-muted-foreground mt-0.5">coins &amp; $ at risk</p>
            </div>
          </div>

          {/* Stress test pipeline diagram — mobile: vertical */}
          <div className="flex flex-col items-center gap-3 md:hidden">
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Select Target</p>
              <p className="text-xs text-muted-foreground mt-0.5">pick a coin</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Override to D</p>
              <p className="text-xs text-muted-foreground mt-0.5">force downgrade</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Recompute Dep. Risk</p>
              <p className="text-xs text-muted-foreground mt-0.5">cascade upstream</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Impact Report</p>
              <p className="text-xs text-muted-foreground mt-0.5">coins &amp; $ at risk</p>
            </div>
          </div>

          {/* Systemic Risk Scoreboard */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Systemic Risk Scoreboard</h3>
            <p>
              On page load, the scoreboard pre-computes the five most damaging single-coin failure
              scenarios. For each targetable coin (one that has dependents), it simulates a downgrade
              to D, counts the number of affected coins, and sums their market cap as &ldquo;supply at
              risk.&rdquo; Results are sorted by supply at risk descending.
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
              <li>The stress test models only the dependency risk channel, not second-order market effects</li>
            </ul>
          </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      <Card id="blacklist-tracker-methodology" className="scroll-mt-28 rounded-xl border-l-[3px] border-l-rose-500">
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Blacklist Tracker Methodology</CardTitle>
            <span className="inline-flex items-center rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-rose-500">
              {BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link href={BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH} className="text-xs text-foreground underline underline-offset-4 hover:text-rose-500 transition-colors">
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when tracked contracts, event parsing rules, cursor semantics, or amount-enrichment logic change.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>
            The Blacklist Tracker monitors issuer intervention events across USDC, USDT, PAXG, and XAUT contracts, including
            blacklist, unblacklist, and destroy/wipe actions across EVM and Tron networks.
          </p>
          <p>
            Methodology revisions document changes to event coverage, cross-chain decoding behavior, cursor safety policies,
            and amount attribution rules that affect historical interpretation and comparability over time.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
