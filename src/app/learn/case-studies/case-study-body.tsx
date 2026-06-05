import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
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
import { CaseStudyTimeline } from "./case-study-timeline";
import type { CaseStudy, CaseStudyOutcome } from "./content/types";

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
              OUTCOME_CHIP[study.outcome],
            )}
          >
            {OUTCOME_LABEL[study.outcome]}
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
            <span className="text-muted-foreground"> · ${low.toFixed(3)}</span>
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
      <FactStrip study={study} />
      <HowPharosSawIt study={study} kickerClass={kickerClass} />
      <Timeline study={study} kickerClass={kickerClass} />
      <Narrative study={study} kickerClass={kickerClass} />
      <Watchpoints study={study} kickerClass={kickerClass} />
      <RelatedCoins study={study} kickerClass={kickerClass} />
      <Sources study={study} kickerClass={kickerClass} />
      <CrossLinksFooter links={study.crossLinks} kickerClass={kickerClass} />
    </>
  );
}
