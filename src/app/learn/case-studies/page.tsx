import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { MECHANISM_ARCHETYPE_LABELS } from "@shared/lib/classification";
import { buildPageMetadata } from "@/lib/page-metadata";
import { CASE_STUDY_LIST } from "./content";
import { CaseStudyListJsonLd } from "./case-study-json-ld";
import { CaseStudyList, type CaseStudyListItem } from "./case-study-list";
import { CaseStudyPageShell } from "./case-study-page-shell";

const PRIORITY_CASE_STUDY_SLUGS = [
  "terra-ust-2022",
  "iron-titan-2021",
  "fei-protocol",
] as const;

const PRIORITY_CASE_STUDY_SUMMARIES: Record<(typeof PRIORITY_CASE_STUDY_SLUGS)[number], string> = {
  "terra-ust-2022":
    "Terra UST and LUNA show how reflexive redemption loops, subsidized demand, and exit liquidity can collapse together.",
  "iron-titan-2021":
    "IRON and TITAN are the compact death-spiral case for fractional collateral, confidence breaks, and reflexive governance-token supply.",
  "fei-protocol":
    "Fei Protocol is the incentive-design case study: direct incentives, protocol-controlled value, and what breaks when peg defense fights users.",
};

const priorityCaseStudies = PRIORITY_CASE_STUDY_SLUGS.map((slug) => {
  const study = CASE_STUDY_LIST.find((candidate) => candidate.slug === slug);
  if (!study) throw new Error(`Missing priority case study: ${slug}`);
  return study;
});

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
);

export default function CaseStudiesHub() {
  return (
    <CaseStudyPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Case Studies", url: "/learn/case-studies/" },
      ]}
      title="When the peg broke"
      subtitle="Practitioner retrospectives of the depegs and failures that reshaped the stablecoin market — what happened, why the design produced it, and what each one left behind. Built on Pharos data."
    >
      <CaseStudyListJsonLd studies={CASE_STUDY_LIST} />
      <section aria-labelledby="case-study-starting-points" className="space-y-4 border-y border-border/60 py-5">
        <div className="space-y-2">
          <p className="pharos-kicker">Start Here</p>
          <h2 id="case-study-starting-points" className="text-xl font-semibold text-foreground">
            Reflexive collapse case studies
          </h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Start with the older evergreen failures that explain reflexive collapse patterns before reading the full
            archive.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {priorityCaseStudies.map((study) => (
            <Link
              key={study.slug}
              href={`/learn/case-studies/${study.slug}/`}
              className="pharos-focus-ring group flex h-full flex-col rounded-lg border border-border/60 bg-card/40 p-4 transition-colors hover:border-frost-blue/40"
            >
              <p className="text-sm font-semibold text-foreground transition-colors group-hover:text-frost-blue">
                {study.title}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {PRIORITY_CASE_STUDY_SUMMARIES[study.slug as (typeof PRIORITY_CASE_STUDY_SLUGS)[number]]}
              </p>
              <span className="mt-auto inline-flex items-center gap-1 pt-3 text-xs font-medium text-frost-blue opacity-80 transition-opacity group-hover:opacity-100">
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
    </CaseStudyPageShell>
  );
}
