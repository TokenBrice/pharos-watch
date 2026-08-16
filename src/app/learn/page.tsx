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
import { ARCHETYPE_VISUALS } from "@/lib/mechanism-explainers/types";
import { CASE_STUDY_LIST, CASE_STUDY_OUTCOME_COUNTS } from "@/lib/case-studies";
import { content as usdcSvb2023 } from "@/lib/case-studies/usdc-svb-2023";
import { content as terraUst2022 } from "@/lib/case-studies/terra-ust-2022";
import { content as usd0ppUsual2025 } from "@/lib/case-studies/usd0pp-usual-2025";
import type { CaseStudyOutcome } from "@/lib/case-studies/types";
import {
  CASE_STUDY_OUTCOME_CHIP_BASE,
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "@/lib/case-study-outcomes";
import { GLOSSARY_ENTRIES } from "@/lib/glossary-content";

export const metadata: Metadata = buildPageMetadata({
  title: "Learn Stablecoin Mechanisms and Case Studies",
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

// Outcome vocabulary for the verdict ledger. Bar fills match the existing
// segmented bar; figure colors reuse the case-study outcome-chip palette so the
// ledger, the chips, and the rows all speak one color. `note` follows the
// CaseStudyOutcome contract (survived = recovered, wounded = scarred-but-live,
// died = decommissioned).
const LEDGER_OUTCOMES = [
  {
    key: "survived",
    label: "Survived",
    note: "clawed back to the dollar",
    fill: "bg-emerald-500",
    figure: "text-emerald-700 dark:text-emerald-400",
  },
  {
    key: "wounded",
    label: "Wounded",
    note: "still trading, structurally scarred",
    fill: "bg-amber-500",
    figure: "text-amber-700 dark:text-amber-400",
  },
  {
    key: "died",
    label: "Died",
    note: "delisted, never recovered",
    fill: "bg-rose-500",
    figure: "text-rose-600 dark:text-rose-400",
  },
] as const satisfies ReadonlyArray<{
  key: CaseStudyOutcome;
  label: string;
  note: string;
  fill: string;
  figure: string;
}>;

// The verdict band: the page's focal point. Leads with the body count, then the
// full breakdown as big figures over a proportional bar. Every number is derived
// from CASE_STUDY_LIST, so the copy can never drift from the archive.
function OutcomeLedger({
  total,
  counts,
}: {
  total: number;
  counts: Record<CaseStudyOutcome, number>;
}) {
  return (
    <section
      aria-labelledby="learn-verdict"
      className="pharos-card-shell space-y-7 p-6 sm:p-7"
    >
      <div className="space-y-3">
        <p className="pharos-kicker">The verdict so far</p>
        <p
          id="learn-verdict"
          className="pharos-display max-w-[34rem] text-balance text-[1.6rem] font-extrabold leading-[1.1] tracking-[-0.02em] text-foreground sm:text-[2.4rem]"
        >
          {total} depegs, reconstructed in full.{" "}
          <span className="text-rose-600 dark:text-rose-400">
            {counts.died} of these coins never came back.
          </span>
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-x-6 gap-y-1">
        {LEDGER_OUTCOMES.map((outcome) => (
          <div key={outcome.key} className="space-y-1.5">
            <dd
              className={cn(
                "pharos-numeric text-[2rem] font-semibold leading-none sm:text-[3rem]",
                outcome.figure,
              )}
            >
              {counts[outcome.key]}
            </dd>
            <dt className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground">
              {outcome.label}
            </dt>
            <p className="text-xs leading-snug text-muted-foreground">{outcome.note}</p>
          </div>
        ))}
      </dl>

      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-border/40"
        role="img"
        aria-label={`Across ${total} case studies: ${counts.survived} survived, ${counts.wounded} wounded, ${counts.died} died.`}
      >
        {LEDGER_OUTCOMES.map((outcome) => (
          <div
            key={outcome.key}
            className={outcome.fill}
            style={{ flexGrow: counts[outcome.key] }}
          />
        ))}
      </div>
    </section>
  );
}

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
          <span className="pharos-numeric text-sm font-semibold tracking-[0.1em] text-muted-foreground">
            {index}
          </span>
          <h2
            id={headingId}
            className="pharos-display text-2xl font-bold tracking-tight text-foreground transition-colors group-hover:text-frost-blue sm:text-3xl"
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
        className="pharos-focus-ring group inline-flex shrink-0 items-center gap-1.5 rounded-sm font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-foreground"
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
  const mechanismTotal = MECHANISM_ARCHETYPE_VALUES.reduce(
    (sum, archetype) => sum + mechanismCounts[archetype],
    0,
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
      title="How Stables Work & Break"
      subtitle="How stablecoins hold a dollar, why they break it, and the vocabulary Pharos uses to name the risk."
    >
      <OutcomeLedger total={totalStudies} counts={CASE_STUDY_OUTCOME_COUNTS} />

      {/* 01 — Case Studies: the evidence */}
      <section
        aria-labelledby="learn-case-studies"
        className="space-y-6 border-t border-border/60 pt-12 sm:pt-14"
      >
        <ModuleHeader
          index="01"
          headingId="learn-case-studies"
          title="Case Studies"
          href="/learn/case-studies/"
          blurb="How a peg breaks. Long-form retrospectives of real depegs: what happened, why the design produced it, and how far the price fell."
          cta={`Read all ${totalStudies}`}
        />
        <ol className="divide-y divide-border/50 border-t border-border/50">
          {MARQUEE_STUDIES.map((study) => {
            const low = study.eventWindow.lowPrice;
            return (
              <li key={study.slug}>
                <Link
                  href={`/learn/case-studies/${study.slug}/`}
                  className="pharos-focus-ring group grid gap-x-6 gap-y-2.5 py-5 hover:bg-muted/30 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto] sm:items-baseline"
                >
                  <div className="space-y-0.5">
                    {low != null ? (
                      <>
                        <p className="pharos-numeric text-[1.7rem] font-semibold leading-none text-foreground">
                          ${low.toFixed(2)}
                        </p>
                        <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                          peg low
                        </p>
                      </>
                    ) : null}
                  </div>
                  <div className="min-w-0 space-y-1.5">
                    <p
                      className={cn(
                        "pharos-kicker",
                        ARCHETYPE_VISUALS[study.archetype].kickerClass,
                      )}
                    >
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
            );
          })}
        </ol>
      </section>

      {/* 02 — Mechanisms: the taxonomy */}
      <section
        aria-labelledby="learn-mechanisms"
        className="space-y-6 border-t border-border/60 pt-12 sm:pt-14"
      >
        <ModuleHeader
          index="02"
          headingId="learn-mechanisms"
          title="Mechanisms"
          href="/learn/mechanisms/"
          blurb={`How a peg is produced. Every active stablecoin runs one of ${MECHANISM_ARCHETYPE_VALUES.length} designs — ${mechanismTotal} coins in total, each defending the dollar differently and failing differently under stress.`}
          cta="Explore every mechanism"
        />
        <ul className="grid gap-x-10 sm:grid-cols-2">
          {MECHANISM_ARCHETYPE_VALUES.map((archetype) => (
            <li key={archetype}>
              <Link
                href={getMechanismExplainerPath(archetype)}
                className="pharos-focus-ring group block border-t border-border/40 py-3.5 hover:bg-muted/30"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <p className="font-semibold leading-snug text-foreground transition-colors group-hover:text-frost-blue">
                    {getMechanismArchetypeLabel(archetype)}
                  </p>
                  <p className="shrink-0 pharos-numeric text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
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
                <span className="shrink-0 pharos-numeric text-[10px] uppercase tracking-[0.08em] text-muted-foreground/80">
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
            className="pharos-focus-ring rounded-sm font-mono uppercase tracking-[0.08em] text-foreground hover:underline hover:underline-offset-4"
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
