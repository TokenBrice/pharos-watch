import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { MECHANISM_ARCHETYPE_LABELS } from "@shared/lib/classification";
import { buildPageMetadata } from "@/lib/page-metadata";
import { cn } from "@/lib/utils";
import { ARCHETYPE_VISUALS } from "../mechanisms/content/types";
import { SectionHeading, SectionKicker } from "../_shared/section-primitives";
import { LearnHero } from "../_shared/learn-hero";
import { CASE_STUDY_LIST } from "./content";
import type { CaseStudyOutcome } from "./content/types";
import { content as terraUst2022 } from "./content/terra-ust-2022";
import { content as ironTitan2021 } from "./content/iron-titan-2021";
import { content as feiProtocol } from "./content/fei-protocol";
import { CaseStudyListJsonLd } from "./case-study-json-ld";
import { CaseStudyList, type CaseStudyListItem } from "./case-study-list";
import { LearnPageShell } from "../_shared/learn-page-shell";

// Reference the priority content modules directly so a renamed/removed module is
// a compile-time import error rather than a runtime throw via slug lookup.
const priorityCaseStudies = [
  {
    study: terraUst2022,
    summary:
      "Terra UST and LUNA show how reflexive redemption loops, subsidized demand, and exit liquidity can collapse together.",
  },
  {
    study: ironTitan2021,
    summary:
      "IRON and TITAN are the compact death-spiral case for fractional collateral, confidence breaks, and reflexive governance-token supply.",
  },
  {
    study: feiProtocol,
    summary:
      "Fei Protocol is the incentive-design case study: direct incentives, protocol-controlled value, and what breaks when peg defense fights users.",
  },
];
const priorityCaseStudySlugs = new Set(priorityCaseStudies.map(({ study }) => study.slug));

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Depeg Case Studies",
  description:
    "Long-form retrospectives of the stablecoin depegs and failures that shaped the market — Terra, USDC/SVB, DAI, and more — sourced from Pharos data.",
  canonical: "/learn/case-studies/",
  ogImage: `${SITE_ORIGIN}/og-editorial-learn.png`,
});

const caseStudyListItems: readonly CaseStudyListItem[] = CASE_STUDY_LIST.map(
  (study) => ({
    slug: study.slug,
    title: study.title,
    subtitle: study.subtitle,
    eyebrow: study.eyebrow,
    archetype: study.archetype,
    outcome: study.outcome,
    eventDateLabel: study.eventDateLabel,
  }),
).filter((study) => !priorityCaseStudySlugs.has(study.slug));

export default function CaseStudiesHub() {
  // Outcome spread for the header hero, derived from the archive so the copy can
  // never drift. The archive count itself is neutral → frost One-Beam; the
  // breakdown figures stay semantic (emerald/amber/rose).
  const outcomeCounts = CASE_STUDY_LIST.reduce(
    (acc, study) => {
      acc[study.outcome] += 1;
      return acc;
    },
    { survived: 0, wounded: 0, died: 0 } as Record<CaseStudyOutcome, number>,
  );

  return (
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Case Studies", url: "/learn/case-studies/" },
      ]}
      title="When the peg broke"
      subtitle="Practitioner retrospectives of the depegs and failures that reshaped the stablecoin market — what happened, why the design produced it, and what each one left behind. Built on Pharos data."
      titleClassName="max-w-[24ch]"
    >
      <CaseStudyListJsonLd studies={CASE_STUDY_LIST} />
      <LearnHero
        beamLabel="Depegs reconstructed"
        beamValue={CASE_STUDY_LIST.length}
        subKicker="Outcome spread"
        sub={
          <p className="pharos-numeric text-sm text-muted-foreground">
            <span className="text-emerald-700 dark:text-emerald-400">
              {outcomeCounts.survived}
            </span>{" "}
            survived
            <span aria-hidden="true" className="px-1.5 text-muted-foreground/50">
              ·
            </span>
            <span className="text-amber-700 dark:text-amber-400">
              {outcomeCounts.wounded}
            </span>{" "}
            wounded
            <span aria-hidden="true" className="px-1.5 text-muted-foreground/50">
              ·
            </span>
            <span className="text-rose-600 dark:text-rose-400">
              {outcomeCounts.died}
            </span>{" "}
            died
          </p>
        }
        ariaLabel="Case study archive"
      />
      <section aria-labelledby="case-study-starting-points" className="space-y-4 border-y border-border/60 py-5">
        <div className="space-y-2">
          <SectionKicker>Start Here</SectionKicker>
          <SectionHeading id="case-study-starting-points">
            Reflexive collapse case studies
          </SectionHeading>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Start with the older evergreen failures that explain reflexive collapse patterns before reading the full
            archive.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {priorityCaseStudies.map(({ study, summary }) => (
            <Link
              key={study.slug}
              href={`/learn/case-studies/${study.slug}/`}
              className="pharos-card-shell pharos-focus-ring group flex h-full flex-col p-4 transition-colors hover:border-frost-blue/60"
            >
              <p
                className={cn(
                  "pharos-kicker mb-2",
                  ARCHETYPE_VISUALS[study.archetype].kickerClass,
                )}
              >
                {study.eyebrow}
              </p>
              <p className="text-sm font-semibold text-foreground transition-colors group-hover:text-frost-blue">
                {study.title}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {summary}
              </p>
              <span className="mt-auto inline-flex items-center gap-1 pt-3 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                Read the case study
                <ArrowUpRight
                  className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </span>
            </Link>
          ))}
        </div>
      </section>
      <CaseStudyList
        studies={caseStudyListItems}
        archetypeLabels={MECHANISM_ARCHETYPE_LABELS}
      />
    </LearnPageShell>
  );
}
