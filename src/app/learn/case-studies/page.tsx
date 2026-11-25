import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { CASE_STUDY_OUTCOME_CLASSES, MECHANISM_ARCHETYPE_LABELS } from "@shared/lib/classification";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { CaseStudy, CaseStudyOutcome } from "@shared/types/editorial-content";
import {
  CASE_STUDY_OUTCOME_BARS,
  CASE_STUDY_OUTCOME_CHIP_BASE,
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "@/lib/case-study-outcomes";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildPageMetadata } from "@/lib/page-metadata";
import { cn } from "@/lib/utils";
import { SectionHeading, SectionKicker } from "../_shared/section-primitives";
import { LearnHero } from "../_shared/learn-hero";
import { CASE_STUDY_LIST, CASE_STUDY_OUTCOME_COUNTS } from "@/lib/case-studies";
import terraUst2022 from "@/lib/case-studies/terra-ust-2022.json";
import ironTitan2021 from "@/lib/case-studies/iron-titan-2021.json";
import feiProtocol from "@/lib/case-studies/fei-protocol.json";
import { formatSignedBps } from "./case-study-format";
import { CaseStudyListJsonLd } from "./case-study-json-ld";
import {
  CaseStudyList,
  type CaseStudyListItem,
  type PriorityCaseStudySummary,
} from "./case-study-list";
import { estimateCaseStudyReadingMinutes } from "./case-study-reading-time";
import { LearnPageShell } from "../_shared/learn-page-shell";

// Reference the priority content modules directly so a renamed/removed module is
// a compile-time import error rather than a runtime throw via slug lookup.
const priorityCaseStudies: ReadonlyArray<{ study: CaseStudy; summary: string }> = [
  {
    study: terraUst2022 as CaseStudy,
    summary:
      "Terra UST and LUNA show how reflexive redemption loops, subsidized demand, and exit liquidity can collapse together.",
  },
  {
    study: ironTitan2021 as CaseStudy,
    summary:
      "IRON and TITAN are the compact death-spiral case for fractional collateral, confidence breaks, and reflexive governance-token supply.",
  },
  {
    study: feiProtocol as CaseStudy,
    summary:
      "Fei Protocol is the incentive-design case study: direct incentives, protocol-controlled value, and what breaks when peg defense fights users.",
  },
];
const priorityCaseStudySlugs = new Set(priorityCaseStudies.map(({ study }) => study.slug));
const priorityStudiesMeta: readonly PriorityCaseStudySummary[] = priorityCaseStudies.map(({ study }) => ({
  outcome: study.outcome,
  archetype: study.archetype,
}));

export const metadata: Metadata = buildPageMetadata({
  title: `Stablecoin Depeg History: ${CASE_STUDY_LIST.length} Case Studies`,
  description: `${CASE_STUDY_LIST.length} stablecoin depeg and failure case studies, from Terra to USDC at SVB: what broke, why the design allowed it, and how each played out (${CASE_STUDY_OUTCOME_COUNTS.died} died, ${CASE_STUDY_OUTCOME_COUNTS.wounded} wounded, ${CASE_STUDY_OUTCOME_COUNTS.survived} survived).`,
  canonical: "/learn/case-studies/",
});

const caseStudyListItems: readonly CaseStudyListItem[] = CASE_STUDY_LIST
  .filter((study) => !priorityCaseStudySlugs.has(study.slug))
  .map((study) => {
    const primaryMeta = study.primaryCoinId
      ? TRACKED_META_BY_ID.get(study.primaryCoinId)
      : undefined;
    return {
      slug: study.slug,
      title: study.title,
      subtitle: study.subtitle,
      eyebrow: study.eyebrow,
      archetype: study.archetype,
      outcome: study.outcome,
      eventDateLabel: study.eventDateLabel,
      eventStartISO: study.eventWindow.startISO,
      peakDeviationBps: study.eventWindow.peakDeviationBps ?? null,
      lowPrice: study.eventWindow.lowPrice ?? null,
      metricScope: study.eventWindow.metricScope ?? null,
      readingMinutes: estimateCaseStudyReadingMinutes(study),
      primaryCoinLogoSrc: study.primaryCoinId
        ? (getLogoSrc(logosById, study.primaryCoinId) ?? null)
        : null,
      primaryCoinSymbol: primaryMeta?.symbol ?? null,
    };
  });

function OutcomeLedgerBar() {
  const total = CASE_STUDY_LIST.length;
  const segments: ReadonlyArray<{
    outcome: CaseStudyOutcome;
    label: string;
    count: number;
    pct: number;
    barClass: string;
  }> = (["survived", "wounded", "died"] as const).map((outcome) => {
    const count = CASE_STUDY_OUTCOME_COUNTS[outcome];
    return {
      outcome,
      label: CASE_STUDY_OUTCOME_LABELS[outcome],
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
      barClass: CASE_STUDY_OUTCOME_BARS[outcome],
    };
  });
  const summary = segments
    .map((segment) => `${segment.count} ${segment.label.toLowerCase()} (${segment.pct}%)`)
    .join(", ");

  return (
    <div className="space-y-3">
      <p className="pharos-label">Outcome ledger</p>
      <div
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-meter-track"
        role="img"
        aria-label={`Case study outcomes across ${total} studies: ${summary}.`}
      >
        {segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <span
              key={segment.outcome}
              aria-hidden="true"
              className={cn(
                "h-full min-w-[3px] first:rounded-l-full last:rounded-r-full",
                segment.barClass,
              )}
              style={{ flexGrow: segment.count }}
            />
          ))}
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {segments.map((segment) => (
          <li key={segment.outcome} className="pharos-chart-legend-chip">
            <span
              aria-hidden="true"
              className={cn("h-2 w-2 shrink-0 rounded-sm", segment.barClass)}
            />
            <span className="pharos-numeric font-semibold text-foreground">
              {segment.count}
            </span>
            <span>{segment.label}</span>
            <span className="pharos-numeric text-muted-foreground/80">
              ({segment.pct}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function CaseStudiesHub() {
  // Outcome spread for the header hero, derived from the archive so the copy can
  // never drift. The archive count itself stays neutral-ink One Beam; the
  // breakdown figures stay semantic (emerald/amber/rose).
  return (
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Case Studies", url: "/learn/case-studies/" },
      ]}
      title="When the peg broke"
      subtitle="Practitioner retrospectives of the depegs and failures that reshaped the stablecoin market: what happened, why the design produced it, and what each one left behind. Built on Pharos data."
      titleClassName="max-w-[24ch]"
    >
      <CaseStudyListJsonLd studies={CASE_STUDY_LIST} />
      <LearnHero
        beamLabel="Case studies reconstructed"
        beamValue={CASE_STUDY_LIST.length}
        subKicker="Outcome spread"
        sub={
          <p className="pharos-meta text-sm">
            <span className={cn("pharos-numeric font-semibold", CASE_STUDY_OUTCOME_CLASSES.survived.text)}>
              {CASE_STUDY_OUTCOME_COUNTS.survived}
            </span>{" "}
            survived
            <span aria-hidden="true" className="px-1.5 text-muted-foreground/50">
              ·
            </span>
            <span className={cn("pharos-numeric font-semibold", CASE_STUDY_OUTCOME_CLASSES.wounded.text)}>
              {CASE_STUDY_OUTCOME_COUNTS.wounded}
            </span>{" "}
            wounded
            <span aria-hidden="true" className="px-1.5 text-muted-foreground/50">
              ·
            </span>
            <span className={cn("pharos-numeric font-semibold", CASE_STUDY_OUTCOME_CLASSES.died.text)}>
              {CASE_STUDY_OUTCOME_COUNTS.died}
            </span>{" "}
            died
          </p>
        }
        ariaLabel="Case study archive"
      >
        <OutcomeLedgerBar />
      </LearnHero>
      <section
        id="start-here"
        aria-labelledby="case-study-starting-points"
        className="scroll-mt-24 space-y-4 border-y border-border/60 py-6"
      >
        <div className="space-y-2">
          <SectionKicker>Start here</SectionKicker>
          <SectionHeading id="case-study-starting-points">
            Reflexive collapse case studies
          </SectionHeading>
          <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">
            Start with the older evergreen failures that explain reflexive collapse patterns before reading the full
            archive.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {priorityCaseStudies.map(({ study, summary }) => {
            const peak = study.eventWindow.peakDeviationBps;
            const low = study.eventWindow.lowPrice;
            return (
              <Link
                key={study.slug}
                href={`/learn/case-studies/${study.slug}/`}
                className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex h-full flex-col p-5"
              >
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <p className="pharos-label">{study.eyebrow}</p>
                  <span
                    className={cn(
                      CASE_STUDY_OUTCOME_CHIP_BASE,
                      CASE_STUDY_OUTCOME_CHIPS[study.outcome],
                    )}
                  >
                    {CASE_STUDY_OUTCOME_LABELS[study.outcome]}
                  </span>
                </div>
                <p className="text-base font-semibold leading-snug text-foreground transition-colors group-hover:text-brand-accent-text">
                  {study.title}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {summary}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/40 pt-3 pharos-meta">
                  <span className="pharos-numeric text-foreground/85">{study.eventDateLabel}</span>
                  {peak != null ? (
                    <>
                      <span aria-hidden="true" className="text-muted-foreground/50">·</span>
                      <span className="pharos-numeric font-medium text-foreground">
                        {formatSignedBps(peak)}
                      </span>
                    </>
                  ) : null}
                  {low != null ? (
                    <>
                      <span aria-hidden="true" className="text-muted-foreground/50">·</span>
                      <span className="pharos-numeric text-muted-foreground">
                        low ${low.toFixed(3)}
                      </span>
                    </>
                  ) : null}
                </div>
                <span className="mt-auto inline-flex items-center gap-1 pt-3 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                  Read the case study
                  <ArrowUpRight
                    className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </Link>
            );
          })}
        </div>
      </section>
      <CaseStudyList
        studies={caseStudyListItems}
        archetypeLabels={MECHANISM_ARCHETYPE_LABELS}
        priorityStudies={priorityStudiesMeta}
      />
    </LearnPageShell>
  );
}
