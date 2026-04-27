import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { MethodologySections } from "./methodology-sections";
import { MethodologyModeToggle } from "@/components/methodology-mode-toggle";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { safeJsonLd } from "@/lib/json-ld";
import { buildFaqJsonLd } from "@/lib/faq";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  METHODOLOGY_READING_STEPS,
  METHODOLOGY_SECTIONS,
  READER_GUIDE_COPY,
} from "./methodology-shared";
import { SAFETY_SCORE_VERSION_LABEL } from "@shared/lib/safety-score-version";

export const metadata: Metadata = buildPageMetadata({
  title: "Methodology: How Pharos Grades Stablecoins",
  description:
    "Full methodology behind Pharos safety grades, peg scores, liquidity scores, and contagion stress tests. Transparent scoring for every stablecoin.",
  canonical: "/methodology/",
  ogImage: `${SITE_URL}/og-methodology.png`,
});

export default function MethodologyPage() {
  return (
    <div className="mx-auto w-full max-w-[76rem] space-y-8">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Methodology", url: "/methodology/" },
        ]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(buildFaqJsonLd([
            {
              question: "How does Pharos grade stablecoins?",
              answer: `Pharos computes a weighted average of four base dimensions — Liquidity / Exit (30%), Resilience (20%), Decentralization (15%), and Dependency Risk (25%) — then applies (pegScore / 100)^0.40 as a peg stability power-curve multiplier. Redemption backstops can improve Liquidity only when the route is currently usable and the redemption snapshot is fresh; documented issuer exits add only a DEX-gated primary-market bonus, while severe active depegs use the open event peak for final caps and disable static or non-live-direct redemption uplift unless live-open redemption evidence exists. When liquidity data is absent, a 10% penalty is applied to the final score after the peg multiplier (weights are redistributed across available dimensions). Grades range from A+ (87+) to F (0–39), with NR for insufficient data. The methodology is currently at ${SAFETY_SCORE_VERSION_LABEL}.`,
            },
            {
              question: "How is the Pharos peg score calculated?",
              answer: "The peg score is a composite 0–100 measure combining time-at-peg (50%) and event severity (50%), minus penalties for active depegs and erratic behavior. The tracking window spans up to 4 years but is capped at the coin's actual age, using a curated launch date when available and otherwise falling back to the earliest supply snapshot. It requires at least 7 days of tracking data; scores under 30 days are flagged as early.",
            },
            {
              question: "What is the DEWS early-warning system?",
              answer: "The Depeg Early Warning System (DEWS) combines eight weighted 0-100 sub-signals: supply contraction, pool stress, liquidity erosion, price confidence, cross-source divergence, blacklist activity, mint/burn flow stress, and yield warnings. Available signals are blended with redistribution, then PSI and same-peg contagion can amplify the score. Bands are CALM <=15, WATCH <=35, ALERT <=55, WARNING <=75, and DANGER above 75.",
            },
            {
              question: "How is the liquidity score calculated?",
              answer: "The liquidity score evaluates how easily a stablecoin can be exited through DEX markets. It combines TVL depth (30%), 24-hour volume activity (20%), pool quality (20%), durability (20%), and pair diversity (10%). TVL depth uses effective TVL relative to market cap, volume uses a log-scale volume/TVL ratio, pool quality measures mechanism and balance-health retention, durability blends TVL stability, volume consistency, maturity, and organic fees, and pair diversity counts distinct retained pools.",
            },
            {
              question: "How does Pharos confirm depegs and maintain DEWS history?",
              answer: "Pending depegs require same-direction corroboration before promotion. Pharos treats opposite-side secondary evidence as contradiction, not support, and only trusts aggregate DEX confirmation when the row is fresh and backed by at least $1M of source TVL. Historical DEWS snapshots do not retain that DEX trust metadata, so the repair path refreshes current rows and prunes unrecomputable daily history back to the March 9, 2026 trust-floor boundary when needed.",
            },
            {
              question: "What does the contagion stress test measure?",
              answer: "The contagion stress test simulates a simultaneous 50% market-cap loss across the top 5 stablecoins and measures the correlated impact on every tracked coin. It uses rolling 90-day return correlations and applies a severity amplifier based on each coin's dependency-risk exposure. The result is a projected grade under stress, shown as a before/after comparison on each coin's detail page.",
            },
            {
              question: "What is the Bank Run Gauge?",
              answer: "The Bank Run Gauge is a market-cap-weighted composite of each tracked stablecoin's issuance-chain net flow versus its own trailing 30-day baseline. It is a signed -100 to +100 pressure signal. Scores below -10 indicate worsening redemption pressure; scores above +10 indicate improving issuance pressure. It returns null when insufficient data is available.",
            },
          ])),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "Article",
            additionalType: "https://schema.org/TechArticle",
            headline: "Methodology: How Pharos Grades Stablecoins",
            description:
              "Full methodology behind Pharos safety grades, peg scores, liquidity scores, and contagion stress tests.",
            author: { "@id": `${SITE_URL}#person-tokenbrice` },
            publisher: { "@id": `${SITE_URL}#organization` },
            image: `${SITE_URL}/og-methodology.png`,
            mainEntityOfPage: `${SITE_URL}/methodology/`,
            keywords: ["stablecoin methodology", "safety score", "PegScore", "DEWS", "PSI", "liquidity score"],
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
                contagion risk. Treat this page like a reference manual, not a marketing explainer. All scoring
                methodologies operate over the active subset of tracked stablecoins; pre-launch and frozen coins are
                excluded from new computations and live aggregates.
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
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {METHODOLOGY_READING_STEPS.map((step) => (
                    <div key={step.label} className="rounded-md border border-border/50 bg-background/40 p-2">
                      <p className="text-[11px] font-semibold text-foreground">{step.label}</p>
                      <p className="text-[10px] text-muted-foreground leading-snug">{step.description}</p>
                    </div>
                  ))}
                </div>
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
