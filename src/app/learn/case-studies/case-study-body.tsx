import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import {
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { cn } from "@/lib/utils";
import { ARCHETYPE_VISUALS } from "../mechanisms/content/types";
import { RelatedCoinsList } from "../_shared/related-coins-list";
import {
  CrossLinksFooter,
  NumberedListSection,
  SectionHeading,
  SectionKicker,
} from "../_shared/section-primitives";
import { CaseStudyChart } from "./case-study-chart";
import {
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "./case-study-outcomes";
import { CaseStudyShare } from "./case-study-share";
import { CaseStudyTimeline } from "./case-study-timeline";
import { CASE_STUDY_LIST } from "./content";
import type { CaseStudy } from "./content/types";

const WORDS_PER_MINUTE = 200;

/** slug -> position in CASE_STUDY_LIST, built once so neighbour math avoids repeated O(n) scans. */
const CASE_STUDY_INDEX_BY_SLUG = new Map(CASE_STUDY_LIST.map((study, index) => [study.slug, index]));

/** Reading time in minutes from the lead + narrative body (~200 wpm, min 1). */
function estimateReadingMinutes(study: CaseStudy): number {
  const text = [
    ...study.lead,
    ...study.sections.flatMap((section) => section.paragraphs),
  ].join(" ");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function ArticleMeta({ study }: { study: CaseStudy }) {
  const minutes = estimateReadingMinutes(study);
  return (
    <div className="-mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground tabular-nums">
        ~{minutes} min read
        <span aria-hidden="true" className="px-1.5 text-muted-foreground/60">
          ·
        </span>
        {study.eventDateLabel}
      </p>
      <CaseStudyShare />
    </div>
  );
}

function Takeaways({
  study,
  kickerClass,
}: {
  study: CaseStudy;
  kickerClass: string;
}) {
  const takeaways = study.takeaways ?? [];
  if (takeaways.length === 0) return null;
  return (
    <section className="space-y-5">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>The short version</SectionKicker>
        <SectionHeading>Key takeaways</SectionHeading>
      </div>
      <ul className="space-y-3 rounded-xl border border-border/50 bg-card/40 p-5 sm:p-6">
        {takeaways.map((point, i) => (
          <li
            key={i}
            className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 text-[15px] leading-relaxed text-foreground"
          >
            <ArrowRight
              className="mt-1 h-4 w-4 shrink-0 text-frost-blue"
              aria-hidden="true"
            />
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Up to `max` other studies sharing this study's archetype, padded with the
 * nearest neighbours in `CASE_STUDY_LIST` order when fewer than `max` match.
 * Reads the list dynamically so newly-added studies surface automatically.
 */
function pickRelatedStudies(study: CaseStudy, max = 3): CaseStudy[] {
  const others = CASE_STUDY_LIST.filter((s) => s.slug !== study.slug);
  const sameArchetype = others.filter((s) => s.archetype === study.archetype);
  const picked = [...sameArchetype];
  if (picked.length < max) {
    const index = CASE_STUDY_INDEX_BY_SLUG.get(study.slug) ?? -1;
    const byDistance = others
      .filter((s) => !picked.includes(s))
      .map((s) => ({
        study: s,
        distance: Math.abs((CASE_STUDY_INDEX_BY_SLUG.get(s.slug) ?? -1) - index),
      }))
      .sort((a, b) => a.distance - b.distance)
      .map((entry) => entry.study);
    for (const candidate of byDistance) {
      if (picked.length >= max) break;
      picked.push(candidate);
    }
  }
  return picked.slice(0, max);
}

function PrevNextPager({ study }: { study: CaseStudy }) {
  const index = CASE_STUDY_INDEX_BY_SLUG.get(study.slug) ?? -1;
  if (index === -1 || CASE_STUDY_LIST.length < 2) return null;
  const count = CASE_STUDY_LIST.length;
  // Wrap-around so the archive reads as a continuous loop.
  const prev = CASE_STUDY_LIST[(index - 1 + count) % count];
  const next = CASE_STUDY_LIST[(index + 1) % count];
  return (
    <nav
      aria-label="Case study pager"
      className="grid gap-3 sm:grid-cols-2"
    >
      <Link
        href={`/learn/case-studies/${prev.slug}/`}
        className="pharos-focus-ring group flex flex-col gap-1 rounded-xl border border-border/50 bg-card/40 px-5 py-4 transition-colors hover:border-frost-blue/60"
      >
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          <ArrowLeft
            className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5"
            aria-hidden="true"
          />
          Previous
        </span>
        <span className="text-[15px] font-semibold leading-snug text-foreground transition-colors group-hover:text-frost-blue">
          {prev.title}
        </span>
      </Link>
      <Link
        href={`/learn/case-studies/${next.slug}/`}
        className="pharos-focus-ring group flex flex-col gap-1 rounded-xl border border-border/50 bg-card/40 px-5 py-4 text-right transition-colors hover:border-frost-blue/60 sm:items-end"
      >
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          Next
          <ArrowRight
            className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
        <span className="text-[15px] font-semibold leading-snug text-foreground transition-colors group-hover:text-frost-blue">
          {next.title}
        </span>
      </Link>
    </nav>
  );
}

function RelatedStudies({
  study,
  kickerClass,
}: {
  study: CaseStudy;
  kickerClass: string;
}) {
  const related = pickRelatedStudies(study, 3);
  if (related.length === 0) return null;
  return (
    <section className="space-y-5">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>Keep reading</SectionKicker>
        <SectionHeading>Related case studies</SectionHeading>
      </div>
      <ul className="divide-y divide-border/40">
        {related.map((item) => (
          <li key={item.slug}>
            <Link
              href={`/learn/case-studies/${item.slug}/`}
              className="pharos-focus-ring group grid gap-1 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-8"
            >
              <div className="flex flex-col gap-1">
                <span
                  className={cn(
                    "pharos-kicker",
                    ARCHETYPE_VISUALS[item.archetype].kickerClass,
                  )}
                >
                  {item.eyebrow}
                </span>
                <span className="text-[15px] font-semibold leading-snug text-foreground transition-colors group-hover:text-frost-blue">
                  {item.title}
                </span>
              </div>
              <ArrowUpRight
                className="hidden h-4 w-4 shrink-0 self-center text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-frost-blue sm:block"
                aria-hidden="true"
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FactStrip({ study }: { study: CaseStudy }) {
  const peak = study.eventWindow.peakDeviationBps;
  const low = study.eventWindow.lowPrice;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border border-border/50 bg-card/40 p-5 sm:grid-cols-4 sm:p-6">
      <div className="space-y-1">
        <dt className="pharos-kicker text-muted-foreground">Outcome</dt>
        <dd>
          <span
            className={cn(
              "inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide",
              CASE_STUDY_OUTCOME_CHIPS[study.outcome],
            )}
          >
            {CASE_STUDY_OUTCOME_LABELS[study.outcome]}
          </span>
        </dd>
      </div>
      <div className="space-y-1">
        <dt className="pharos-kicker text-muted-foreground">When</dt>
        <dd className="font-mono text-sm tabular-nums text-foreground">
          {study.eventDateLabel}
        </dd>
      </div>
      <div className="space-y-1">
        <dt className="pharos-kicker text-muted-foreground">Mechanism</dt>
        <dd className="text-sm text-foreground">
          <Link
            href={getMechanismExplainerPath(study.archetype)}
            className="pharos-focus-ring underline-offset-4 hover:text-frost-blue hover:underline"
          >
            {getMechanismArchetypeLabel(study.archetype)}
          </Link>
        </dd>
      </div>
      <div className="space-y-1">
        <dt className="pharos-kicker text-muted-foreground">Peak deviation</dt>
        <dd className="font-mono text-sm tabular-nums text-foreground">
          {peak != null ? `${peak > 0 ? "+" : ""}${peak} bps` : "—"}
          {low != null ? (
            <span className="block text-xs font-normal text-muted-foreground">
              low ${low.toFixed(3)}
            </span>
          ) : null}
        </dd>
      </div>
    </dl>
  );
}

function HowPharosSawIt({
  study,
  kickerClass,
}: {
  study: CaseStudy;
  kickerClass: string;
}) {
  if (!study.dataWidgets || study.dataWidgets.length === 0) return null;
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>How Pharos saw it</SectionKicker>
        <SectionHeading>The peg on the tape</SectionHeading>
      </div>
      <div className="space-y-6">
        {study.dataWidgets.map((widget) => (
          <CaseStudyChart key={widget.coinId} widget={widget} />
        ))}
      </div>
    </section>
  );
}

function Timeline({
  study,
  kickerClass,
}: {
  study: CaseStudy;
  kickerClass: string;
}) {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>How it unfolded</SectionKicker>
        <SectionHeading>Timeline</SectionHeading>
      </div>
      <CaseStudyTimeline entries={study.timeline} />
    </section>
  );
}

function Narrative({
  study,
  kickerClass,
}: {
  study: CaseStudy;
  kickerClass: string;
}) {
  return (
    <>
      {study.sections.map((section, i) => (
        <section key={i} className="space-y-4">
          <SectionKicker className={kickerClass}>
            {String(i + 1).padStart(2, "0")}
          </SectionKicker>
          <SectionHeading>{section.heading}</SectionHeading>
          <div className="space-y-3 text-[15px] leading-relaxed text-muted-foreground">
            {section.paragraphs.map((paragraph, j) => (
              <p key={j}>{paragraph}</p>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function Watchpoints({
  study,
  kickerClass,
}: {
  study: CaseStudy;
  kickerClass: string;
}) {
  return (
    <NumberedListSection
      items={study.watchpoints}
      kicker="What to watch if this recurs"
      heading="Watchpoints"
      kickerClass={kickerClass}
    />
  );
}

function RelatedCoins({
  study,
  kickerClass,
}: {
  study: CaseStudy;
  kickerClass: string;
}) {
  const related = study.relatedCoins ?? [];
  if (related.length === 0) return null;
  return (
    <RelatedCoinsList
      coins={related}
      kickerClass={kickerClass}
      kicker="The blast radius"
      heading="Coins caught in the contagion"
    />
  );
}

function Sources({
  study,
  kickerClass,
}: {
  study: CaseStudy;
  kickerClass: string;
}) {
  return (
    <section className="space-y-5">
      <SectionKicker className={kickerClass}>Primary sources</SectionKicker>
      <ul className="divide-y divide-border/40">
        {study.sources.map((source, i) => (
          <li key={i}>
            <a
              href={source.href}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring group flex items-start justify-between gap-3 py-3 text-[15px] leading-snug text-foreground transition-colors hover:text-frost-blue"
            >
              <span>{source.label}</span>
              <ArrowUpRight
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-frost-blue"
                aria-hidden="true"
              />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CaseStudyBody({ study }: { study: CaseStudy }) {
  const kickerClass = ARCHETYPE_VISUALS[study.archetype].kickerClass;
  return (
    <>
      <ArticleMeta study={study} />
      <FactStrip study={study} />
      <Takeaways study={study} kickerClass={kickerClass} />
      <HowPharosSawIt study={study} kickerClass={kickerClass} />
      <Timeline study={study} kickerClass={kickerClass} />
      <Narrative study={study} kickerClass={kickerClass} />
      <Watchpoints study={study} kickerClass={kickerClass} />
      <RelatedCoins study={study} kickerClass={kickerClass} />
      <Sources study={study} kickerClass={kickerClass} />
      <CrossLinksFooter links={study.crossLinks} kickerClass={kickerClass} />
      <RelatedStudies study={study} kickerClass={kickerClass} />
      <PrevNextPager study={study} />
    </>
  );
}
