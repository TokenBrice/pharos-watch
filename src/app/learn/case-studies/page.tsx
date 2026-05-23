import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { buildPageMetadata } from "@/lib/page-metadata";
import { cn } from "@/lib/utils";
import { ARCHETYPE_VISUALS } from "../mechanisms/content/types";
import { CASE_STUDY_LIST } from "./content";
import { CaseStudyListJsonLd } from "./case-study-json-ld";
import { CaseStudyPageShell } from "./case-study-page-shell";
import type { CaseStudyOutcome } from "./content/types";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Depeg Case Studies",
  description:
    "Long-form retrospectives of the stablecoin depegs and failures that shaped the market — Terra, USDC/SVB, DAI, and more — sourced from Pharos data.",
  canonical: "/learn/case-studies/",
  ogImage: `${SITE_ORIGIN}/og-editorial-learn.png`,
});

const OUTCOME_LABEL: Record<CaseStudyOutcome, string> = {
  survived: "Survived",
  wounded: "Wounded",
  died: "Died",
};

const OUTCOME_CHIP: Record<CaseStudyOutcome, string> = {
  survived: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  wounded: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  died: "border-rose-500/40 text-rose-600 dark:text-rose-400",
};

export default function CaseStudiesHub() {
  return (
    <CaseStudyPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Learn", url: "/learn/" },
        { name: "Case Studies", url: "/learn/case-studies/" },
      ]}
      title="When the peg broke"
      subtitle="Practitioner retrospectives of the depegs and failures that reshaped the stablecoin market — what happened, why the design produced it, and what each one left behind. Built on Pharos data."
    >
      <CaseStudyListJsonLd studies={CASE_STUDY_LIST} />
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
                      OUTCOME_CHIP[study.outcome],
                    )}
                  >
                    {OUTCOME_LABEL[study.outcome]}
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
