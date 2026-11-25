import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { JsonLdScript } from "@/components/json-ld-script";
import { MethodologySections } from "./sections/methodology-sections";
import { MethodologyModeToggle } from "@/components/methodology-mode-toggle";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";
import { cn } from "@/lib/utils";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { FaqSection } from "@/components/faq-section";
import type { FaqItem } from "@/lib/faq";
import { buildPageMetadata, getPageSocialPreview } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { formatUtcDayLabel } from "@shared/lib/format";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { SAFETY_SCORE_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/registry";
import { V9_PROVISIONAL_UNKNOWN_WEIGHT_THRESHOLD } from "@shared/types/safety-score-v9-public";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { METHODOLOGY_LINK_CLASS, METHODOLOGY_READING_STEPS, READER_GUIDE_COPY } from "./methodology-shared";
import { SafetyGradeScaleBar } from "./sections/core/safety-scores-overview";
import { METHODOLOGY_SECTIONS } from "@/lib/methodology-content";
import { DEFINITIONS } from "@/lib/definitions";

const { gradeThresholds, pillarWeights } = V9_CANDIDATE_POLICY_V1.policy.semantic.formula;
const formatWeight = (weight: number) => `${Math.round(weight * 100)}%`;
const METHODOLOGY_TITLE = `Stablecoin Safety Score Methodology (${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL})`;
const METHODOLOGY_DESCRIPTION = `How Pharos grades stablecoins ${gradeThresholds[0].grade} to ${gradeThresholds.at(-1)!.grade}: Backing ${formatWeight(pillarWeights.backing)}, Exit ${formatWeight(pillarWeights.exit)}, Economic Control ${formatWeight(pillarWeights.control)}, with peg, liquidity and dependency inputs. Safety Score ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}.`;
// Freshness comes from the Safety Score changelog (newest entry first), the
// same source the scoring-changelog page uses for its TechArticle dates.
const SAFETY_SCORE_FIRST_ENTRY_DATE = SAFETY_SCORE_METHODOLOGY_CHANGELOG.at(-1)!.date;
const SAFETY_SCORE_LATEST_ENTRY_DATE = SAFETY_SCORE_METHODOLOGY_CHANGELOG[0].date;

export const metadata: Metadata = buildPageMetadata({
  title: METHODOLOGY_TITLE,
  description: METHODOLOGY_DESCRIPTION,
  canonical: "/methodology/",
});

const METHODOLOGY_FAQ_ITEMS = [
  {
    question: "How does Pharos grade stablecoins?",
    answer:
      `The Safety Score evaluates Backing (40%), Exit (35%), and Economic Control (25%). Exit stresses 5% of usable supply within $1M-$25M. Route materiality separately uses 5% of supply within $100K-$25M: capacity below both 1% of that amount and $100K gets no route credit. A material route with valued completion below 1% of the actual stress request is capped at 50 before confidence. Bounded aggregation limits how far strong pillars lift a weak path; peg behavior, caps, dependencies and wrappers can constrain the result. At least two usable pillars permit rating, pricing an unavailable third as uncertainty; fewer are a technical Pipeline gap, while genuine required-parent unavailability can yield NR. Grades range from A+ (87+) to F (0-39). A Provisional label marks more than ${V9_PROVISIONAL_UNKNOWN_WEIGHT_THRESHOLD * 100}% unknown-priced scoring weight without changing the score.`,
  },
  {
    question: "How is the Pharos peg score calculated?",
    answer:
      "The peg score is a composite 0-100 measure combining time-at-peg (50%) and event severity (50%), minus penalties for active depegs and erratic behavior. The tracking window spans up to 4 years but begins at a reviewed replay-coverage date when one exists; otherwise it falls back to the coin's age or earliest durable observation. It requires at least 7 days of tracking data and a usable price within the last UTC day; a coin with no usable price for a full UTC day reads NR.",
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
      "Since methodology v9.1, mint risk is graded once by the Safety Score Economic Control pillar; the standalone Mint Authority Score is retired. The published 0-100 mint component evaluates native issuance on the canonical deployment or deployments and the controls that can expand or replace it. Representations, adapters, lockboxes, messaging, route limits, bridge upgrades, and bridge administrators are scored separately on the bridge routes they govern, even when a controller also appears in Mint Authority. Missing or unresolved required evidence stays explicit as NR rather than receiving a guessed score.",
  },
  {
    question: "How does Pharos confirm depegs and maintain DEWS history?",
    answer:
      "Every depeg onset must remain beyond the full trigger threshold for at least 15 minutes before promotion, even when multiple sources agree. A native CoinGecko quote can initiate a non-USD candidate but cannot confirm itself; a fresh canonical USD price from a non-CoinGecko family must agree after authoritative FX normalization. Live events resolve only after 15 minutes inside a tighter half-threshold recovery band. Pharos treats opposite-side evidence as contradiction, does not count DefiLlama's CoinGecko mirror as independent, and only trusts aggregate DEX confirmation when the row is fresh and backed by at least $1M of source TVL. Historical DEWS snapshots do not retain that DEX trust metadata, so the repair path refreshes current rows and prunes unrecomputable daily history back to the March 9, 2026 trust-floor boundary when needed.",
  },
  {
    question: "What is the Bank Run Gauge?",
    answer:
      DEFINITIONS.bankRunGauge.long,
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
      <JsonLdScript
        json={safeJsonLd(
          buildArticleJsonLd({
            additionalType: "https://schema.org/TechArticle",
            headline: METHODOLOGY_TITLE,
            description: METHODOLOGY_DESCRIPTION,
            datePublished: `${SAFETY_SCORE_FIRST_ENTRY_DATE}T00:00:00Z`,
            dateModified: `${SAFETY_SCORE_LATEST_ENTRY_DATE}T00:00:00Z`,
            author: "person",
            image: `${SITE_URL}${getPageSocialPreview("/methodology/").url}`,
            mainEntityOfPage: `${SITE_URL}/methodology/`,
            keywords: [
              "stablecoin methodology",
              "safety score",
              "mint-control component",
              "PegScore",
              "DEWS",
              "PSI",
              "liquidity score",
            ],
          }),
        )}
      />

      {/* Heading */}
      <div className="space-y-3">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(18rem,0.28fr)] xl:items-end">
          <div className="space-y-3">
            <div className="space-y-2">
              <h1 className="pharos-page-title">Methodology</h1>
              <p className="pharos-page-lead">
                How Pharos grades stablecoins: transparent scoring across safety, peg stability, mint control,
                liquidity, yield, and dependency risk.
              </p>
              <p className="text-xs text-muted-foreground">
                Safety Score methodology{" "}
                <span className="pharos-numeric text-foreground/85">{SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}</span> · updated{" "}
                <time dateTime={SAFETY_SCORE_LATEST_ENTRY_DATE} className="pharos-numeric text-foreground/85">
                  {formatUtcDayLabel(new Date(`${SAFETY_SCORE_LATEST_ENTRY_DATE}T00:00:00Z`))}
                </time>
              </p>
              <p className="pharos-lead">
                Treat this page like a reference manual, not a marketing explainer. All scoring methodologies operate
                over the active subset of tracked stablecoins; pre-launch and frozen coins are excluded from new
                computations and live aggregates.
              </p>
            </div>
          </div>
          <div className="hidden pharos-card-shell space-y-3 px-4 py-4 md:block" data-testid="methodology-reader-guide-desktop">
            <div className="space-y-1.5">
              <p className="pharos-label">Reader guide</p>
              <p className="text-sm text-foreground">{READER_GUIDE_COPY}</p>
            </div>
            <MethodologyModeToggle />
          </div>
        </div>
      </div>

      {/* Answer first: what a grade means and its bands, before the reader meta. */}
      <section aria-labelledby="methodology-at-a-glance" className="pharos-card-shell space-y-4 px-4 py-4 sm:px-5">
        <div className="space-y-1">
          <p className="pharos-label">At a glance</p>
          <h2 id="methodology-at-a-glance" className="pharos-section-title">
            What a Safety Score grade means
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          A grade answers one question: if the coin started bleeding tomorrow, how much of the loss would the holder
          eat before the system stopped it? Backing (
          <span className="pharos-numeric">{formatWeight(pillarWeights.backing)}</span>), Exit (
          <span className="pharos-numeric">{formatWeight(pillarWeights.exit)}</span>) and Economic Control (
          <span className="pharos-numeric">{formatWeight(pillarWeights.control)}</span>) form the score; peg behavior,
          caps and dependencies can constrain it. NR means a rating is genuinely unavailable, never a low score.{" "}
          <a href="#safety-scores-methodology" className={METHODOLOGY_LINK_CLASS}>
            Full Safety Score method
          </a>
        </p>
        <SafetyGradeScaleBar />
        <p className="border-t border-border/50 pt-3 text-xs leading-relaxed text-muted-foreground">
          New to stablecoin design?{" "}
          <Link href="/learn/mechanisms/" className={METHODOLOGY_LINK_CLASS}>
            Learn how each stablecoin design produces its peg
          </Link>{" "}
          before the scoring formulas.
        </p>
      </section>

      <div className="pharos-card-shell px-4 py-4 md:hidden">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="pharos-label">Reader guide</p>
            <p className="text-sm text-foreground">{READER_GUIDE_COPY}</p>
          </div>
          <MethodologyModeToggle className="w-full justify-between" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Page rhythm: <span className="text-foreground">summary</span>, quick facts, worked example, technical
            notes.
          </p>
          <div className="grid grid-cols-2 gap-2 pt-1">
            {METHODOLOGY_READING_STEPS.map((step) => (
              <div key={step.label} className="pharos-inset p-2.5">
                <p className="text-2xs font-semibold text-foreground">{step.label}</p>
                <p className="text-3xs leading-snug text-muted-foreground">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <section
        aria-labelledby="methodology-reading-guide"
        className="pharos-subtle-band hidden space-y-3 px-4 py-3.5 md:block"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="methodology-reading-guide" className="pharos-label text-foreground">
            How to read this page
          </h2>
          <p className="text-xs text-muted-foreground">
            Each section follows the same rhythm so you can skim first, then expand only the parts that need a deeper
            read.
          </p>
        </div>
        <ol className="grid gap-3 border-t border-border/50 pt-3 text-sm text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
          {METHODOLOGY_READING_STEPS.map((step, index) => (
            <li
              key={step.label}
              className={cn(
                "space-y-1 border-border/50",
                index % 2 === 1 ? "md:border-l md:pl-3.5" : "md:pl-0",
                index > 0 ? "xl:border-l xl:pl-3.5" : "xl:border-l-0 xl:pl-0",
              )}
            >
              <p className="pharos-label">{step.label}</p>
              <p className="text-xs leading-relaxed text-foreground/90">{step.description}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Long-form preface: pinned copy, written once, not regenerated. */}
      <section
        aria-label="Editorial preface"
        className="mx-auto w-full max-w-[68ch] border-y border-border/60 py-6 md:py-8"
      >
        <p className="pharos-label text-foreground/80">Editorial preface</p>
        <h2 className="pharos-display mt-2.5 text-2xl font-semibold leading-tight tracking-tight text-foreground sm:text-3xl">
          How Pharos grades every stablecoin, and what it refuses to grade.
        </h2>
        <div className="mt-5 space-y-4 text-sm leading-relaxed text-foreground/90 sm:text-base sm:leading-7">
          <p>
            Every safety grade Pharos publishes is the answer to one question: if this stablecoin started bleeding
            tomorrow, how much of the loss would the holder eat before the system stopped it? The Safety Score answers
            through three material pillars. Backing (40%) measures the assets and loss-absorption structure behind the
            claim. Exit (35%) measures whether holders can leave through executable market or redemption routes.
            Economic Control (25%) measures who can change, freeze, mint, or otherwise impair that claim.
          </p>
          <p>
            The model does not let a strong unrelated pillar average away a weak material path. Its bounded aggregation
            grants limited headroom above the weakest pillar, then peg behavior, evidence sufficiency, track record,
            structural caps, dependencies, and wrapper-local risks can only constrain the published result. A missing
            required fact returns NR unless a reviewed bounded policy states exactly why the remaining uncertainty is
            rateable.
          </p>
          <p>
            Dependencies are causal inputs rather than a standalone score. A serial wrapper cannot escape its parent;
            basket exposure is weighted and bounded according to reviewed materiality. Wrapper-local custody, control,
            transfer, and redemption facts remain visible alongside the inherited limit, so the downstream claim can
            be worse than its parent but cannot become safer by averaging in unrelated strengths. Risk-absorption
            wrappers hold first-loss capital that is junior to the parent&apos;s own holders, so they publish their own
            risk-absorption form and take the strategy-vault deduction whoever operates them; native-staked treatment
            is reserved for senior savings wrappers.
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
        <p className="mt-6 text-sm italic text-muted-foreground">
          Pharos, July 2026
        </p>
      </section>

      <LongformScrollspyNav
        sections={METHODOLOGY_SECTIONS}
        navAriaLabel="Methodology section controls"
        edgeFade
        rightSlot={
          // A hairline separates the mode controls from the scrolling pills so a
          // clipped last pill fades out instead of butting into "Show inputs".
          <div className="flex items-center gap-2 border-l border-border/60 pl-2 sm:gap-3 sm:pl-3">
            <ShowYourWorkToggle className="pharos-control-pill pharos-focus-ring hidden min-h-9 md:inline-flex" />
            <MethodologyModeToggle compact />
          </div>
        }
      />

      <MethodologySections />

      <FaqSection items={METHODOLOGY_FAQ_ITEMS} title="Methodology FAQ" includeJsonLd />
    </div>
  );
}
