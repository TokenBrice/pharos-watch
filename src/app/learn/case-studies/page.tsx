import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { buildPageMetadata } from "@/lib/page-metadata";
import { cn } from "@/lib/utils";
import { ARCHETYPE_VISUALS } from "../mechanisms/content/types";
import { CASE_STUDY_LIST } from "./content";
import { CaseStudyListJsonLd } from "./case-study-json-ld";
import {
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "./case-study-outcomes";
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
              className="pharos-focus-ring group block border-t border-border/60 pt-4 md:border-t-0 md:pt-0"
            >
              <p className="text-sm font-semibold text-foreground transition-colors group-hover:text-frost-blue">
                {study.title}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {PRIORITY_CASE_STUDY_SUMMARIES[study.slug as (typeof PRIORITY_CASE_STUDY_SLUGS)[number]]}
              </p>
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-frost-blue opacity-80 transition-opacity group-hover:opacity-100">
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
      <ol className="divide-y divide-border/60">
        {CASE_STUDY_LIST.map((study, index) => (
          <li key={study.slug}>
            <Link
              href={`/learn/case-studies/${study.slug}/`}
              className="pharos-focus-ring group grid gap-3 py-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-12 lg:py-10"
            >
              <div className="flex flex-col gap-3">
                <p
                  className={cn(
                    "pharos-kicker",
                    ARCHETYPE_VISUALS[study.archetype].kickerClass,
                  )}
                >
                  <span className="mr-2 tabular-nums text-muted-foreground">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {study.eyebrow}
                </p>
                <h2 className="text-[clamp(1.6rem,2.4vw,2.25rem)] font-extrabold leading-[1.05] tracking-[-0.025em] text-foreground transition-colors group-hover:text-frost-blue">
                  {study.title}
                </h2>
                <p className="max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
                  {study.subtitle}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  <span>{study.eventDateLabel}</span>
                  <span
                    className={cn(
                      "inline-flex rounded-full border px-2 py-0.5 tracking-wide",
                      CASE_STUDY_OUTCOME_CHIPS[study.outcome],
                    )}
                  >
                    {CASE_STUDY_OUTCOME_LABELS[study.outcome]}
                  </span>
                </div>
              </div>
              <span className="hidden items-start pt-1 text-frost-blue opacity-70 transition-opacity group-hover:opacity-100 lg:inline-flex">
                <ArrowUpRight
                  className="h-5 w-5 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </CaseStudyPageShell>
  );
}
