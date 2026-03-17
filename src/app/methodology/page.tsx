import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { MethodologySections } from "./methodology-sections";
import { MethodologyModeToggle } from "@/components/methodology-mode-toggle";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  METHODOLOGY_READING_STEPS,
  METHODOLOGY_SECTIONS,
  READER_GUIDE_COPY,
} from "./methodology-shared";
import { SAFETY_SCORE_VERSION_LABEL } from "@shared/lib/safety-score-version";

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
    type: "website",
    images: [{ url: "https://pharos.watch/og-methodology.png", width: 1200, height: 628 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-methodology.png", width: 1200, height: 628 }],
  },
};

export default function MethodologyPage() {
  return (
    <div className="mx-auto w-full max-w-[76rem] space-y-8">
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
                  text: "The liquidity score is a composite 0–100 metric combining TVL depth (35%), volume activity (20%), pool quality (22.5%), durability (15%), and pair diversity (7.5%). Volume uses log-scale scoring. Pool quality is adjusted for mechanism type, balance health, and pair quality.",
                },
              },
            ],
          }),
        }}
      />

      {/* Breadcrumb + heading */}
      <div className="space-y-3">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground">Methodology</span>
        </nav>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(18rem,0.28fr)] xl:items-end">
          <div className="space-y-3">
            <div className="space-y-2">
              <h1 className="text-4xl font-extrabold tracking-tighter sm:text-[3.4rem]">Methodology</h1>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                How Pharos grades stablecoins: transparent scoring across safety, peg stability, liquidity, yield, and
                contagion risk. Treat this page like a reference manual, not a marketing explainer.
              </p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-card/72 px-4 py-4 md:hidden">
              <div className="space-y-3">
                <div className="space-y-2">
                  <p className="pharos-kicker">Reader Guide</p>
                  <p className="text-sm text-foreground">{READER_GUIDE_COPY}</p>
                </div>
                <MethodologyModeToggle className="w-full justify-between border-border/70 bg-background/90" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Page rhythm: <span className="text-foreground">summary</span>, quick facts, worked example, technical
                  notes.
                </p>
              </div>
            </div>
          </div>
          <div className="hidden rounded-2xl border border-border/60 bg-card/72 px-4 py-4 md:block">
            <p className="pharos-kicker">Reader Guide</p>
            <p className="mt-2 text-sm text-foreground">
              {READER_GUIDE_COPY} Use the jump rail toggle to switch modes without losing your place in the page.
            </p>
          </div>
        </div>
      </div>

      <Card className="hidden rounded-xl border border-border/70 bg-card md:block">
        <CardHeader className="space-y-3 pb-2">
          <CardTitle as="h2">How to Read This Page</CardTitle>
          <p className="text-sm text-muted-foreground">
            Each section follows the same rhythm so you can skim first, then expand only the parts that need a deeper
            read.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 border-t border-border/40 pt-5 text-sm text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
          {METHODOLOGY_READING_STEPS.map((step, index) => (
            <div
              key={step.label}
              className={cn(
                "space-y-2 border-border/50",
                index % 2 === 1 ? "md:border-l md:pl-4" : "md:pl-0",
                index > 0 ? "xl:border-l xl:pl-4" : "xl:border-l-0 xl:pl-0",
              )}
            >
              <p className="pharos-kicker">{step.label}</p>
              <p className="text-foreground">{step.description}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <LongformScrollspyNav
        sections={METHODOLOGY_SECTIONS}
        railLabel="Jump to Section"
        navAriaLabel="Methodology section controls"
        rightSlot={
          <div className="hidden md:block">
            <MethodologyModeToggle />
          </div>
        }
      />

      <MethodologySections />
    </div>
  );
}
