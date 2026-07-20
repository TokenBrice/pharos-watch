import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { MethodologySections } from "./methodology-sections";
import { MethodologyModeToggle } from "@/components/methodology-mode-toggle";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { safeJsonLd } from "@/lib/json-ld";
import { buildFaqJsonLd } from "@/lib/faq";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { METHODOLOGY_READING_STEPS, METHODOLOGY_SECTIONS, READER_GUIDE_COPY } from "./methodology-shared";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";

export const metadata: Metadata = buildPageMetadata({
  title: "Methodology: How Pharos Grades Stablecoins",
  description:
    "Full methodology behind Pharos safety grades, mint authority scores, peg scores, liquidity scores, and contagion stress tests. Transparent scoring for every stablecoin.",
  canonical: "/methodology/",
  ogImage: `${SITE_URL}/og-editorial-methodology.png`,
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
          __html: safeJsonLd(
            buildFaqJsonLd([
              {
                question: "How does Pharos grade stablecoins?",
                answer: `Pharos computes a weighted average of four base dimensions — Liquidity / Exit (30%), Resilience (20%), Decentralization (15%), and Dependency Risk (25%) — then applies (pegScore / 100)^0.40 as a peg stability power-curve multiplier. Decentralization starts from governance quality, then can apply chain-infrastructure, reviewed CDP oracle setup, reviewed bridge-route, and Mint Authority penalties; branch-aware oracle profiles use the weakest verified branch when present. Redemption backstops can improve Liquidity only when the route is currently usable, the redemption snapshot is fresh, and v4 current executable capacity supports the modeled exit size; eventual-only issuer exits remain visible but do not replace missing DEX liquidity. Severe active depegs use the open event peak for final caps and disable static or non-live-direct redemption uplift unless live-open redemption evidence exists. When liquidity data is absent, a 10% penalty is applied to the final score after the peg multiplier (weights are redistributed across available dimensions). Grades range from A+ (87+) to F (0–39), with NR for insufficient data. The methodology is currently at ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}.`,
              },
              {
                question: "How is the Pharos peg score calculated?",
                answer:
                  "The peg score is a composite 0–100 measure combining time-at-peg (50%) and event severity (50%), minus penalties for active depegs and erratic behavior. The tracking window spans up to 4 years but begins at a reviewed replay-coverage date when one exists; otherwise it falls back to the coin's age or earliest durable observation. It requires at least 7 days of tracking data; scores under 30 days are flagged as early.",
              },
              {
                question: "What is the DEWS early-warning system?",
                answer:
                  "The Depeg Early Warning System (DEWS) combines eight weighted 0-100 sub-signals: supply contraction, pool stress, liquidity erosion, price confidence, cross-source divergence, blacklist activity, mint/burn flow stress, and yield warnings. Available signals are blended with redistribution, then PSI and same-peg contagion can amplify the score. Bands are CALM <=15, WATCH <=35, ALERT <=55, WARNING <=75, and DANGER above 75.",
              },
              {
                question: "How is the liquidity score calculated?",
                answer:
                  "The liquidity score evaluates how easily a stablecoin can be exited through DEX markets. It combines TVL depth (30%), 24-hour volume activity (20%), pool quality (20%), durability (20%), and pair diversity (10%). TVL depth uses effective TVL relative to market cap, volume uses a log-scale volume/TVL ratio, pool quality measures mechanism and balance-health retention, durability blends TVL stability, volume consistency, maturity, and organic fees, and pair diversity counts distinct retained pools.",
              },
              {
                question: "What is the Mint Authority Score?",
                answer:
                  "Mint Authority Score is a standalone 0-100 score for reviewed stablecoin mint-authority risk. It combines mint route family (30%), weakest mint-capable controller (40%), quantitative bounds (15%), and reviewed authority posture (15%), then applies caps for unbounded or compromised authority, privileged-mint incidents, weak EOA controls, and evidence confidence. Missing or unresolved review data is NR and never penalizes. Since Safety Score v8.0 the score feeds the Decentralization report-card dimension through a penalty-only blend.",
              },
              {
                question: "How does Pharos confirm depegs and maintain DEWS history?",
                answer:
                  "Every depeg onset must remain beyond the full trigger threshold for at least 15 minutes before promotion, even when multiple sources agree. Live events resolve only after 15 minutes inside a tighter half-threshold recovery band. Pharos treats opposite-side evidence as contradiction, does not count DefiLlama's CoinGecko mirror as independent, and only trusts aggregate DEX confirmation when the row is fresh and backed by at least $1M of source TVL. Historical DEWS snapshots do not retain that DEX trust metadata, so the repair path refreshes current rows and prunes unrecomputable daily history back to the March 9, 2026 trust-floor boundary when needed.",
              },
              {
                question: "What does the contagion stress test measure?",
                answer:
                  "The contagion stress test selects one target coin, overrides its overall score to grade D, then recomputes the Dependency Risk dimension for downstream coins that depend on that target. It models the direct dependency channel only, not second-order peg, liquidity, or market-confidence effects. The result is a projected grade under stress, shown as a before/after comparison on each coin's detail page.",
              },
              {
                question: "What is the Bank Run Gauge?",
                answer:
                  "The Bank Run Gauge is a market-cap-weighted composite of each tracked stablecoin's issuance-chain net flow versus its own trailing 30-day baseline. It is a signed -100 to +100 pressure signal. Scores below -10 indicate worsening redemption pressure; scores above +10 indicate improving issuance pressure. It returns null when insufficient data is available.",
              },
            ]),
          ),
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
              "Full methodology behind Pharos safety grades, mint authority scores, peg scores, liquidity scores, and contagion stress tests.",
            author: { "@id": `${SITE_URL}#person-tokenbrice` },
            publisher: { "@id": `${SITE_URL}#organization` },
            image: `${SITE_URL}/og-editorial-methodology.png`,
            mainEntityOfPage: `${SITE_URL}/methodology/`,
            keywords: [
              "stablecoin methodology",
              "safety score",
              "mint authority score",
              "PegScore",
              "DEWS",
              "PSI",
              "liquidity score",
            ],
          }),
        }}
      />

      {/* Heading */}
      <div className="space-y-3">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(18rem,0.28fr)] xl:items-end">
          <div className="space-y-3">
            <div className="space-y-2">
              <h1 className="pharos-page-title">Methodology</h1>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                How Pharos grades stablecoins: transparent scoring across safety, peg stability, mint authority,
                liquidity, yield, and contagion risk. Treat this page like a reference manual, not a marketing
                explainer. All scoring methodologies operate over the active subset of tracked stablecoins; pre-launch
                and frozen coins are excluded from new computations and live aggregates.
              </p>
            </div>
            <div className="pharos-card-shell px-4 py-4 md:hidden">
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
          <div className="hidden pharos-card-shell px-4 py-4 md:block">
            <p className="pharos-kicker">Reader Guide</p>
            <p className="mt-2 text-sm text-foreground">
              {READER_GUIDE_COPY} Use the jump rail toggle to switch modes without losing your place in the page.
            </p>
          </div>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-muted-foreground">
        New to stablecoin design?{" "}
        <Link
          href="/learn/mechanisms/"
          className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 hover:text-foreground"
        >
          Learn how each stablecoin design produces its peg
        </Link>{" "}
        before the scoring formulas.
      </p>

      <Card className="pharos-card-shell hidden md:block">
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

      {/* Long-form preface — pinned copy, written once, not regenerated. */}
      <section
        aria-label="Editorial preface"
        className="mx-auto w-full max-w-[88ch] border-y border-border/60 py-10 md:py-12"
      >
        <p className="pharos-kicker text-foreground/80">Editorial Preface</p>
        <h2
          className="mt-3 text-[clamp(1.65rem,3.2vw,2.35rem)] font-semibold leading-tight tracking-tight text-foreground [text-wrap:balance]"
        >
          How Pharos grades every stablecoin, and what it refuses to grade.
        </h2>
        <div className="mt-6 space-y-5 text-[0.97rem] leading-7 text-foreground/88 sm:text-base sm:leading-8">
          <p>
            Every safety grade Pharos publishes is the answer to one question: if this stablecoin started bleeding
            tomorrow, how much of the loss would the holder eat before the system stopped it? Four base dimensions
            answer different parts of that question. Liquidity / Exit (30%) measures whether you can leave at all.
            Dependency Risk (25%) measures whether something else has to hold for this one to hold. Resilience (20%)
            measures the quality of what backs the coin and who is allowed to touch it. Decentralization (15%) measures
            whether anyone can switch the lights off. We weight them in that order because, in every real depeg we have
            studied, the exit was already gone before the press release went out.
          </p>
          <p>
            The peg score does not sit alongside the four base dimensions. It multiplies them. After the weighted base
            score is computed, we apply{" "}
            <span className="not-italic">
              (pegScore / 100)<sup>0.40</sup>
            </span>{" "}
            as a power curve. The exponent is deliberate. At 1.0, a ten-point drop in peg score would erase ten points
            of safety, which punishes mid-quality pegs more than the data supports. At 0.0, the peg would not constrain
            the grade at all, which would let a structurally fine asset with a chronically wobbly peg coast on
            collateral quality. Forty splits the difference: a peg score of 90 takes about four percent off; a peg score
            of 10 takes sixty percent off. Strong pegs are nearly untouched, broken pegs are sharply demoted, and the
            curve does the work without a cliff.
          </p>
          <p>
            Dependency Risk is the dimension that most often surprises issuers. A wrapper that lives entirely inside a
            parent stablecoin cannot, by construction, be safer than its parent. We enforce that with a variant overall
            cap, not by averaging the parent in. Averaging would let a well-built wrapper around a weak base settle at
            some middle grade that no one should rely on; capping says the downstream cannot escape the upstream, which
            is how the dependency actually behaves under stress. The same logic produces family-specific wrapper
            ceilings for risk-absorption, strategy vaults, and bond-maturity variants. The cap is honest about what the
            asset is: a claim on something else.
          </p>
          <p>
            Yield tokens get flagged, not folded. Pharos tracks yield-bearing and NAV tokens through a separate
            yield-risk pipeline because the failure modes are different in kind, not just degree. A holder of a $1.00
            stablecoin and a holder of a $1.04 wrapper are not running the same trade. The wrapper carries source risk,
            sustainability risk, and benchmark drift that have no analog in the underlying peg. Until those signals are
            sourced to a standard we will publish against, we surface them on the yield page and leave the safety score
            honest about what it does and does not measure. Configured NAV wrappers can still inherit peg risk from a
            referenced base; pure fund-share tokens with no peg reference receive a peg multiplier of 1.0 and are graded
            on the structural dimensions alone.
          </p>
        </div>
        <p className="mt-8 text-sm italic text-muted-foreground">
          &mdash; Pharos, May 2026
        </p>
      </section>

      <LongformScrollspyNav
        sections={METHODOLOGY_SECTIONS}
        railLabel="Jump to Section"
        navAriaLabel="Methodology section controls"
        rightSlot={
          <div className="hidden items-center gap-3 md:flex">
            <ShowYourWorkToggle className="pharos-toggle-pill pharos-focus-ring min-h-9" />
            <MethodologyModeToggle />
          </div>
        }
      />

      <MethodologySections />
    </div>
  );
}
