import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import {
  getMechanismArchetypeLabel,
  getMechanismArchetypeOneLiner,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { countActiveByArchetype } from "@shared/lib/stablecoins/by-mechanism";
import { buildPageMetadata } from "@/lib/page-metadata";
import { cn } from "@/lib/utils";
import { LearnPageShell } from "./_shared/learn-page-shell";
import { CrossLinksFooter } from "./_shared/section-primitives";
import { ARCHETYPE_VISUALS } from "./mechanisms/content/types";
import { CASE_STUDY_LIST } from "./case-studies/content";
import { content as usdcSvb2023 } from "./case-studies/content/usdc-svb-2023";
import { content as terraUst2022 } from "./case-studies/content/terra-ust-2022";
import { content as usd0ppUsual2025 } from "./case-studies/content/usd0pp-usual-2025";
import type { CaseStudyOutcome } from "./case-studies/content/types";
import {
  CASE_STUDY_OUTCOME_CHIP_BASE,
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "./case-studies/case-study-outcomes";
import { GLOSSARY_ENTRIES } from "./glossary/content";

export const metadata: Metadata = buildPageMetadata({
  title: "Learn Stablecoins",
  description:
    "Learn how stablecoins hold their pegs, why they fail, and how Pharos names the risks across mechanisms, case studies, and glossary definitions.",
  canonical: "/learn/",
  ogImage: `${SITE_ORIGIN}/og-editorial-learn.png`,
});

// Marquee studies chosen for outcome spread (survived / died / wounded) and
// mechanism spread. Referenced by direct import so a renamed/removed module is a
// compile-time error rather than a runtime slug miss.
const MARQUEE_STUDIES = [usdcSvb2023, terraUst2022, usd0ppUsual2025] as const;

// The three Pharos-native signals — the terms a reader most needs before the
// data surfaces make sense.
const FEATURED_GLOSSARY_IDS = ["psi", "dews", "pegscore"] as const;

function ModuleHeader({
  index,
  headingId,
  title,
  href,
  blurb,
  cta,
}: {
  index: string;
  headingId: string;
  title: string;
  href: string;
  blurb: string;
  cta: string;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-2.5">
        <Link
          href={href}
          className="pharos-focus-ring group inline-flex items-baseline gap-3 rounded-sm"
        >
          <span className="font-mono text-sm font-semibold tabular-nums tracking-[0.1em] text-frost-blue">
            {index}
          </span>
          <h2
            id={headingId}
            className="text-[clamp(1.6rem,2.8vw,2.1rem)] font-extrabold leading-[1.04] tracking-[-0.03em] text-foreground transition-colors group-hover:text-frost-blue"
          >
            {title}
          </h2>
        </Link>
        <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground">
          {blurb}
        </p>
      </div>
      <Link
        href={href}
        className="pharos-focus-ring group inline-flex shrink-0 items-center gap-1.5 rounded-sm font-mono text-[11px] uppercase tracking-[0.12em] text-frost-blue"
      >
        {cta}
        <ArrowUpRight
          className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </Link>
    </div>
  );
}

export default function LearnIndexPage() {
  const mechanismCounts = countActiveByArchetype();

  const outcomeCounts = CASE_STUDY_LIST.reduce(
    (acc, study) => {
      acc[study.outcome] += 1;
      return acc;
    },
    { survived: 0, wounded: 0, died: 0 } as Record<CaseStudyOutcome, number>,
  );
  const totalStudies = CASE_STUDY_LIST.length;

  const glossaryById = new Map(GLOSSARY_ENTRIES.map((entry) => [entry.id, entry]));
  const featuredTerms = FEATURED_GLOSSARY_IDS.map((id) => glossaryById.get(id)).filter(
    (entry): entry is NonNullable<typeof entry> => Boolean(entry),
  );
  const remainingTerms = GLOSSARY_ENTRIES.length - featuredTerms.length;

  return (
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Learn", url: "/learn/" },
      ]}
      visibleBreadcrumbs={[{ label: "Dashboard", href: "/" }, { label: "Learn" }]}
      title="Learn the peg"
      subtitle="How stablecoins hold a dollar, why they break it, and the vocabulary Pharos uses to name the risk."
      leadParagraphs={[
        "Three ways in, meant to be read in order: how a peg is produced, how it breaks, and the words for both.",
      ]}
    >
      {/* 01 — Mechanisms: the taxonomy */}
      <section
        aria-labelledby="learn-mechanisms"
        className="space-y-6 border-t border-border/60 pt-12 sm:pt-14"
      >
        <ModuleHeader
          index="01"
          headingId="learn-mechanisms"
          title="Mechanisms"
          href="/learn/mechanisms/"
          blurb="How a peg is produced. Every tracked stablecoin runs on one of six designs; each defends the dollar differently, and each fails differently under stress."
          cta="Explore all six"
        />
        <ul className="grid gap-x-10 sm:grid-cols-2">
          {MECHANISM_ARCHETYPE_VALUES.map((archetype) => (
            <li key={archetype}>
              <Link
                href={getMechanismExplainerPath(archetype)}
                className="pharos-focus-ring group block border-t border-border/40 py-3.5"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <p className="font-semibold leading-snug text-foreground transition-colors group-hover:text-frost-blue">
                    {getMechanismArchetypeLabel(archetype)}
                  </p>
                  <p className="shrink-0 font-mono text-[11px] tabular-nums uppercase tracking-[0.08em] text-muted-foreground">
                    <span className="text-foreground">{mechanismCounts[archetype]}</span> live
                  </p>
                </div>
                <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                  {getMechanismArchetypeOneLiner(archetype)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* 02 — Case Studies: the evidence */}
      <section
        aria-labelledby="learn-case-studies"
        className="space-y-6 border-t border-border/60 pt-12 sm:pt-14"
      >
        <ModuleHeader
          index="02"
          headingId="learn-case-studies"
          title="Case Studies"
          href="/learn/case-studies/"
          blurb="How a peg breaks. Long-form retrospectives of real depegs: what happened, why the design produced it, and whether the coin lived."
          cta={`Read all ${totalStudies}`}
        />
        <div className="space-y-2.5">
          <div
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-border/40"
            role="img"
            aria-label={`Across ${totalStudies} case studies: ${outcomeCounts.survived} survived, ${outcomeCounts.wounded} wounded, ${outcomeCounts.died} died.`}
          >
            <div className="bg-emerald-500" style={{ flexGrow: outcomeCounts.survived }} />
            <div className="bg-amber-500" style={{ flexGrow: outcomeCounts.wounded }} />
            <div className="bg-rose-500" style={{ flexGrow: outcomeCounts.died }} />
          </div>
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground"
            aria-hidden="true"
          >
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              {outcomeCounts.survived} survived
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              {outcomeCounts.wounded} wounded
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-rose-500" />
              {outcomeCounts.died} died
            </span>
          </div>
        </div>
        <ol className="divide-y divide-border/50 border-t border-border/50">
          {MARQUEE_STUDIES.map((study) => (
            <li key={study.slug}>
              <Link
                href={`/learn/case-studies/${study.slug}/`}
                className="pharos-focus-ring group grid gap-x-6 gap-y-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline"
              >
                <div className="min-w-0 space-y-1.5">
                  <p className={cn("pharos-kicker", ARCHETYPE_VISUALS[study.archetype].kickerClass)}>
                    {study.eyebrow}
                  </p>
                  <p className="font-semibold leading-snug text-foreground transition-colors group-hover:text-frost-blue">
                    {study.title}
                  </p>
                  <p className="line-clamp-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                    {study.subtitle}
                  </p>
                </div>
                <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground sm:flex-col sm:items-end sm:gap-1.5">
                  <span>{study.eventDateLabel}</span>
                  <span
                    className={cn(
                      CASE_STUDY_OUTCOME_CHIP_BASE,
                      CASE_STUDY_OUTCOME_CHIPS[study.outcome],
                    )}
                  >
                    {CASE_STUDY_OUTCOME_LABELS[study.outcome]}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {/* 03 — Glossary: the lexicon */}
      <section
        aria-labelledby="learn-glossary"
        className="space-y-6 border-t border-border/60 pt-12 sm:pt-14"
      >
        <ModuleHeader
          index="03"
          headingId="learn-glossary"
          title="Glossary"
          href="/learn/glossary/"
          blurb={`The vocabulary, version-pinned. Every Pharos term defined and anchored to the methodology section that uses it, ${GLOSSARY_ENTRIES.length} entries deep.`}
          cta="Open the glossary"
        />
        <dl className="grid gap-x-10 gap-y-6 border-t border-border/40 pt-5 sm:grid-cols-3">
          {featuredTerms.map((entry) => (
            <div key={entry.id} className="space-y-1.5">
              <dt className="flex items-baseline justify-between gap-2">
                <Link
                  href={`/learn/glossary/#${entry.id}`}
                  className="pharos-focus-ring rounded-sm font-semibold text-foreground transition-colors hover:text-frost-blue"
                >
                  {entry.term}
                </Link>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/80">
                  {entry.methodologyVersion}
                </span>
              </dt>
              <dd className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">
                {entry.definition}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          <Link
            href="/learn/glossary/"
            className="pharos-focus-ring rounded-sm font-mono uppercase tracking-[0.08em] text-frost-blue hover:underline hover:underline-offset-4"
          >
            +{remainingTerms} more terms, A&ndash;Z &rarr;
          </Link>
        </p>
      </section>

      <CrossLinksFooter
        kicker="Where to go next"
        kickerClass=""
        links={[
          { href: "/methodology/", label: "Read the scoring methodology" },
          { href: "/safety-scores/", label: "Compare Safety Scores across every coin" },
          { href: "/depeg/", label: "Track live depeg risk on Depeg/DDR" },
          { href: "/cemetery/", label: "Visit the Cemetery of dead stablecoins" },
        ]}
      />
    </LearnPageShell>
  );
}
