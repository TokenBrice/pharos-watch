import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { MethodologySections } from "./sections";
import { MethodologyModeToggle } from "@/components/methodology-mode-toggle";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { FaqSection } from "@/components/faq-section";
import type { FaqItem } from "@/lib/faq";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { METHODOLOGY_READING_STEPS, METHODOLOGY_SECTIONS, READER_GUIDE_COPY } from "./methodology-shared";

export const metadata: Metadata = buildPageMetadata({
  title: "Methodology: How Pharos Grades Stablecoins",
  description:
    "Full methodology behind Pharos V9 safety grades and mint-control evidence, peg scores, liquidity scores, and dependency analysis.",
  canonical: "/methodology/",
  ogImage: `${SITE_URL}/og-editorial-methodology.png`,
});

const METHODOLOGY_FAQ_ITEMS = [
  {
    question: "How does Pharos grade stablecoins?",
    answer:
      "Safety Score V9 evaluates Backing (40%), Exit (35%), and Economic Control (25%). Exit capacity is route-specific: a route below both the first positive 1% coverage and $100K absolute-capacity breakpoints receives no route credit, while a route that reaches $100K but still completes less than 1% is capped at 50. Bounded aggregation then limits how far strong pillars can lift a weak material path, while peg behavior, structural caps, dependencies, wrappers, evidence quality, and track record can constrain the result. Missing required evidence returns NR unless a reviewed bounded policy explicitly keeps the asset rateable. Grades range from A+ (87+) to F (0–39), with NR for insufficient data.",
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
      "Since methodology v9.1 mint risk is graded once, by the Safety Score V9 Economic Control pillar; the standalone Mint Authority Score is retired. The published 0-100 mint component evaluates native issuance on the canonical deployment or deployments and the controls that can expand or replace it. Representations, adapters, lockboxes, messaging, route limits, bridge upgrades, and bridge administrators are scored separately on the bridge routes they govern, even when a controller also appears in Mint Authority. Missing or unresolved required evidence stays explicit as NR rather than receiving a guessed score.",
  },
  {
    question: "How does Pharos confirm depegs and maintain DEWS history?",
    answer:
      "Every depeg onset must remain beyond the full trigger threshold for at least 15 minutes before promotion, even when multiple sources agree. A native CoinGecko quote can initiate a non-USD candidate but cannot confirm itself; a fresh canonical USD price from a non-CoinGecko family must agree after authoritative FX normalization. Live events resolve only after 15 minutes inside a tighter half-threshold recovery band. Pharos treats opposite-side evidence as contradiction, does not count DefiLlama's CoinGecko mirror as independent, and only trusts aggregate DEX confirmation when the row is fresh and backed by at least $1M of source TVL. Historical DEWS snapshots do not retain that DEX trust metadata, so the repair path refreshes current rows and prunes unrecomputable daily history back to the March 9, 2026 trust-floor boundary when needed.",
  },
  {
    question: "What is the Bank Run Gauge?",
    answer:
      "The Bank Run Gauge is a market-cap-weighted composite of each tracked stablecoin's issuance-chain net flow versus its own trailing 30-day baseline. It is a signed -100 to +100 pressure signal. Scores below -10 indicate worsening redemption pressure; scores above +10 indicate improving issuance pressure. It returns null when insufficient data is available.",
  },
] as const satisfies readonly FaqItem[];

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
            buildArticleJsonLd({
              additionalType: "https://schema.org/TechArticle",
              headline: "Methodology: How Pharos Grades Stablecoins",
              description:
                "Full methodology behind Pharos V9 safety grades and mint-control evidence, peg scores, liquidity scores, and dependency analysis.",
              author: "person",
              image: `${SITE_URL}/og-editorial-methodology.png`,
              mainEntityOfPage: `${SITE_URL}/methodology/`,
              keywords: [
                "stablecoin methodology",
                "safety score",
                "V9 mint-control component",
                "PegScore",
                "DEWS",
                "PSI",
                "liquidity score",
              ],
            }),
          ),
        }}
      />

      {/* Heading */}
      <div className="space-y-3">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(18rem,0.28fr)] xl:items-end">
          <div className="space-y-3">
            <div className="space-y-2">
              <h1 className="pharos-page-title">Methodology</h1>
              <p className="pharos-page-lead max-w-3xl">
                How Pharos grades stablecoins: transparent scoring across safety, peg stability, V9 mint control,
                liquidity, yield, and dependency risk.
              </p>
              <p className="pharos-lead max-w-3xl">
                Treat this page like a reference manual, not a marketing explainer. All scoring methodologies operate
                over the active subset of tracked stablecoins; pre-launch and frozen coins are excluded from new
                computations and live aggregates.
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
            tomorrow, how much of the loss would the holder eat before the system stopped it? V9 answers through three
            material pillars. Backing (40%) measures the assets and loss-absorption structure behind the claim. Exit
            (35%) measures whether holders can leave through executable market or redemption routes. Economic Control
            (25%) measures who can change, freeze, mint, or otherwise impair that claim.
          </p>
          <p>
            V9 does not let a strong unrelated pillar average away a weak material path. Its bounded aggregation grants
            limited headroom above the weakest pillar, then peg behavior, evidence sufficiency, track record, structural
            caps, dependencies, and wrapper-local risks can only constrain the published result. A missing required fact
            returns NR unless a reviewed bounded policy states exactly why the remaining uncertainty is rateable.
          </p>
          <p>
            Dependencies are causal inputs rather than a standalone score. A serial wrapper cannot escape its parent;
            basket exposure is weighted and bounded according to reviewed materiality. Wrapper-local custody, control,
            transfer, and redemption facts remain visible alongside the inherited limit, so the downstream claim can
            be worse than its parent but cannot become safer by averaging in unrelated strengths. When a product&apos;s
            risk-absorption label does not establish who operates it, reviewed ownership selects the existing wrapper
            form: third-party wrappers receive strategy-vault treatment, while parent-protocol wrappers receive
            native-staked treatment.
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
          &mdash; Pharos, July 2026
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

      <FaqSection items={METHODOLOGY_FAQ_ITEMS} title="Methodology FAQ" includeJsonLd />
    </div>
  );
}
