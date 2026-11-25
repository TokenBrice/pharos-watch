import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import {
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { slugifyId } from "@shared/lib/format";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { PreferredSourcePrompt } from "@/components/preferred-source-prompt";
import { getLogoSrc, logosById } from "@/lib/logos";
import { cn } from "@/lib/utils";
import { RelatedCoinsList } from "../_shared/related-coins-list";
import {
  CrossLinksFooter,
  NumberedListSection,
  SectionHeading,
  SectionKicker,
} from "../_shared/section-primitives";
import { CaseStudyChart } from "./case-study-chart";
import {
  CASE_STUDY_OUTCOME_BARS,
  CASE_STUDY_OUTCOME_CHIP_BASE,
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "@/lib/case-study-outcomes";
import { CaseStudyTimeline } from "./case-study-timeline";
import {
  formatEventWindowDuration,
  formatEventWindowRange,
  formatSignedBps,
} from "./case-study-format";
import { CASE_STUDY_LIST } from "@/lib/case-studies";
import type { CaseStudy, CaseStudyDataWidget } from "@shared/types/editorial-content";

/** slug -> position in CASE_STUDY_LIST, built once so neighbour math avoids repeated O(n) scans. */
const CASE_STUDY_INDEX_BY_SLUG = new Map(CASE_STUDY_LIST.map((study, index) => [study.slug, index]));

function caseStudySectionId(index: number, heading: string): string {
  return `section-${index + 1}-${slugifyId(heading)}`;
}

/**
 * PegDeviationChart draws a $1 tape; NAV-priced and non-USD coins have no such
 * peg, so they fall back to the archival snapshot instead.
 */
function getLiveChartWidgets(study: CaseStudy): readonly CaseStudyDataWidget[] {
  return (study.dataWidgets ?? []).filter((widget) => {
    const meta = TRACKED_META_BY_ID.get(widget.coinId);
    return meta != null && !meta.flags.navToken && meta.flags.pegCurrency === "USD";
  });
}

function Takeaways({ study }: { study: CaseStudy }) {
  const takeaways = study.takeaways ?? [];
  if (takeaways.length === 0) return null;
  return (
    <section id="key-takeaways" className="scroll-mt-32 space-y-5">
      <div className="space-y-2">
        <SectionKicker>The short version</SectionKicker>
        <SectionHeading>Key takeaways</SectionHeading>
      </div>
      <ul className="pharos-card-shell space-y-3 p-5 sm:p-6">
        {takeaways.map((point, i) => (
          <li
            key={i}
            className="grid max-w-[68ch] grid-cols-[1.25rem_minmax(0,1fr)] gap-3 text-base leading-relaxed text-foreground/90"
          >
            <ArrowRight
              className="mt-1 h-4 w-4 shrink-0 text-brand-accent-text"
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
 * nearest neighbours in `CASE_STUDY_LIST` order when fewer than `max` match,
 * excluding studies already linked in `study.crossLinks`.
 */
function pickRelatedStudies(study: CaseStudy, max = 3): CaseStudy[] {
  const crossLinkedHrefs = new Set(study.crossLinks.map((link) => link.href));
  const others = CASE_STUDY_LIST.filter(
    (s) => s.slug !== study.slug && !crossLinkedHrefs.has(`/learn/case-studies/${s.slug}/`),
  );
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
        className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex flex-col gap-1 px-5 py-4"
      >
        <span className="inline-flex items-center gap-1.5 pharos-label">
          <ArrowLeft
            className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5"
            aria-hidden="true"
          />
          Previous
        </span>
        <span className="text-sm font-semibold leading-snug text-foreground transition-colors group-hover:text-brand-accent-text">
          {prev.title}
        </span>
      </Link>
      <Link
        href={`/learn/case-studies/${next.slug}/`}
        className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex flex-col gap-1 px-5 py-4 sm:items-end sm:text-right"
      >
        <span className="inline-flex items-center gap-1.5 pharos-label">
          Next
          <ArrowRight
            className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
        <span className="text-sm font-semibold leading-snug text-foreground transition-colors group-hover:text-brand-accent-text">
          {next.title}
        </span>
      </Link>
    </nav>
  );
}

function RelatedStudies({ study }: { study: CaseStudy }) {
  const related = pickRelatedStudies(study, 3);
  if (related.length === 0) return null;
  return (
    <section className="space-y-5">
      <div className="space-y-2">
        <SectionKicker>Keep reading</SectionKicker>
        <SectionHeading>Related case studies</SectionHeading>
      </div>
      <ul className="divide-y divide-border/40">
        {related.map((item) => (
          <li key={item.slug}>
            <Link
              href={`/learn/case-studies/${item.slug}/`}
              className="pharos-focus-ring group -mx-3 grid gap-2 rounded-lg px-3 py-4 transition-colors hover:bg-muted/35 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="pharos-label">{item.eyebrow}</span>
                  <span aria-hidden="true" className="text-xs text-muted-foreground/50">·</span>
                  <span className="pharos-numeric text-xs text-muted-foreground">
                    {item.eventDateLabel}
                  </span>
                </div>
                <span className="text-sm font-semibold leading-snug text-foreground transition-colors group-hover:text-brand-accent-text">
                  {item.title}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    CASE_STUDY_OUTCOME_CHIP_BASE,
                    CASE_STUDY_OUTCOME_CHIPS[item.outcome],
                  )}
                >
                  {CASE_STUDY_OUTCOME_LABELS[item.outcome]}
                </span>
                <ArrowUpRight
                  className="hidden h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-brand-accent-text sm:block"
                  aria-hidden="true"
                />
              </div>
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
  const metricScope = study.eventWindow.metricScope;
  return (
    <dl className="pharos-card-shell grid grid-cols-2 gap-x-6 gap-y-4 p-5 sm:grid-cols-4 sm:p-6">
      <div className="space-y-1">
        <dt className="pharos-label">Outcome</dt>
        <dd>
          <span
            className={cn(
              CASE_STUDY_OUTCOME_CHIP_BASE,
              CASE_STUDY_OUTCOME_CHIPS[study.outcome],
            )}
          >
            {CASE_STUDY_OUTCOME_LABELS[study.outcome]}
          </span>
        </dd>
      </div>
      <div className="space-y-1">
        <dt className="pharos-label">When</dt>
        <dd className="pharos-numeric text-sm font-medium text-foreground">
          {study.eventDateLabel}
        </dd>
      </div>
      <div className="space-y-1">
        <dt className="pharos-label">Mechanism</dt>
        <dd className="text-sm font-medium text-foreground">
          <Link
            href={getMechanismExplainerPath(study.archetype)}
            className="pharos-prose-link hover:text-brand-accent-text"
          >
            {getMechanismArchetypeLabel(study.archetype)}
          </Link>
        </dd>
      </div>
      <div className="space-y-1">
        <dt className="pharos-label">Peak deviation</dt>
        <dd className="pharos-numeric text-base font-semibold text-foreground sm:text-lg">
          {peak != null ? formatSignedBps(peak) : "—"}
          {low != null ? (
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
              low ${low.toFixed(3)}
            </span>
          ) : null}
          {metricScope ? (
            <span className="mt-0.5 block font-sans text-xs font-normal text-muted-foreground">
              Scope: {metricScope}
            </span>
          ) : null}
        </dd>
      </div>
    </dl>
  );
}

function EvidenceSnapshot({ study }: { study: CaseStudy }) {
  const windowLabel = formatEventWindowRange(
    study.eventWindow.startISO,
    study.eventWindow.endISO,
  );
  const durationLabel = formatEventWindowDuration(
    study.eventWindow.startISO,
    study.eventWindow.endISO,
  );
  const primaryMeta = study.primaryCoinId
    ? TRACKED_META_BY_ID.get(study.primaryCoinId)
    : undefined;
  const low = study.eventWindow.lowPrice;
  const showParTrack =
    low != null &&
    low < 1 &&
    !primaryMeta?.flags.navToken &&
    (primaryMeta == null || primaryMeta.flags.pegCurrency === "USD");
  const retainedPct = showParTrack ? Math.max(0, Math.min(100, low * 100)) : 0;
  const drawdownPct = showParTrack ? Math.round((1 - low) * 100) : 0;

  const recordLinks = [
    ...(study.primaryCoinId
      ? [{ href: buildStablecoinUrl(study.primaryCoinId), label: "Stablecoin profile" }]
      : []),
    ...(study.cemeteryId ? [{ href: "/cemetery/", label: "Cemetery record" }] : []),
    ...(study.depegEventSlug ? [{ href: "/depeg/", label: "Depeg tracker" }] : []),
  ];

  return (
    <div className="pharos-card-shell space-y-5 p-5 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <p className="pharos-label">Event window</p>
          <p className="pharos-numeric text-sm font-medium text-foreground">{windowLabel}</p>
          {durationLabel ? (
            <p className="pharos-meta">
              Duration: <span className="pharos-numeric text-foreground/85">{durationLabel}</span>
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <p className="pharos-label">Peak deviation</p>
          <p className="pharos-numeric text-base font-semibold text-foreground sm:text-lg">
            {study.eventWindow.peakDeviationBps != null
              ? formatSignedBps(study.eventWindow.peakDeviationBps)
              : "—"}
          </p>
          {study.eventWindow.metricScope ? (
            <p className="text-xs text-muted-foreground">
              Scope: {study.eventWindow.metricScope}
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <p className="pharos-label">Lowest print</p>
          <p className="pharos-numeric text-base font-semibold text-foreground sm:text-lg">
            {low != null ? `$${low.toFixed(3)}` : "—"}
          </p>
        </div>
      </div>

      {showParTrack ? (
        <div className="pharos-inset space-y-2 p-3.5 sm:p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="pharos-meta">
              Par to low:{" "}
              <span className="pharos-numeric font-medium text-foreground">
                $1.00 &rarr; ${low.toFixed(3)}
              </span>
            </p>
            <p className="pharos-numeric text-xs text-muted-foreground">
              -{drawdownPct}% from par
            </p>
          </div>
          <div
            className="flex h-2 w-full overflow-hidden rounded-full bg-meter-track"
            role="img"
            aria-label={`Archived peg drop from $1.00 par to $${low.toFixed(3)} (${drawdownPct}% below par).`}
          >
            <span
              aria-hidden="true"
              className="h-full bg-meter-neutral"
              style={{ width: `${retainedPct}%` }}
            />
            <span
              aria-hidden="true"
              className={cn("h-full", CASE_STUDY_OUTCOME_BARS[study.outcome])}
              style={{ width: `${100 - retainedPct}%` }}
            />
          </div>
          <div className="flex items-center justify-between pharos-numeric text-2xs text-muted-foreground">
            <span>$0.00</span>
            <span>$1.00 par</span>
          </div>
        </div>
      ) : null}

      <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">
        This retrospective is anchored to the archived event window, source-backed timeline, and Pharos records rather than a live embedded series.
      </p>

      {recordLinks.length ? (
        <div className="flex flex-wrap gap-2">
          {recordLinks.map((link) => (
            <Link
              key={`${link.href}-${link.label}`}
              href={link.href}
              className="pharos-focus-ring pharos-control-pill min-h-11 gap-1.5 sm:min-h-9"
            >
              <span>{link.label}</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HowPharosSawIt({
  study,
  widgets,
}: {
  study: CaseStudy;
  widgets: readonly CaseStudyDataWidget[];
}) {
  const hasLiveChart = widgets.length > 0;
  return (
    <section id="peg-on-the-tape" className="scroll-mt-32 space-y-6">
      <div className="space-y-2">
        <SectionKicker>{hasLiveChart ? "How Pharos saw it" : "Archival record"}</SectionKicker>
        <SectionHeading>
          {hasLiveChart ? "The peg on the tape" : "Event window & Pharos records"}
        </SectionHeading>
      </div>
      {hasLiveChart ? (
        <div className="space-y-6">
          {widgets.map((widget, i) => {
            const meta = TRACKED_META_BY_ID.get(widget.coinId);
            return (
              <CaseStudyChart
                key={`${widget.coinId}-${i}`}
                widget={widget}
                eventWindows={study.eventWindows ?? [study.eventWindow]}
                coinSymbol={meta?.symbol}
                coinName={meta?.name}
                coinLogoSrc={getLogoSrc(logosById, widget.coinId) ?? null}
              />
            );
          })}
        </div>
      ) : (
        <EvidenceSnapshot study={study} />
      )}
    </section>
  );
}

function Timeline({ study }: { study: CaseStudy }) {
  return (
    <section id="timeline" className="scroll-mt-32 space-y-6">
      <div className="space-y-2">
        <SectionKicker>How it unfolded</SectionKicker>
        <SectionHeading>Timeline</SectionHeading>
      </div>
      <CaseStudyTimeline entries={study.timeline} />
    </section>
  );
}

function Narrative({ study }: { study: CaseStudy }) {
  return (
    <>
      {study.sections.map((section, i) => (
        <section
          key={section.id}
          id={caseStudySectionId(i, section.heading)}
          className="scroll-mt-32 space-y-4"
        >
          <div className="space-y-2">
            <SectionKicker>Section {String(i + 1).padStart(2, "0")}</SectionKicker>
            <SectionHeading>{section.heading}</SectionHeading>
          </div>
          <div className="max-w-[68ch] space-y-4 text-base leading-[1.75] text-foreground/90">
            {section.paragraphs.map((paragraph, j) => (
              <p key={j}>{paragraph}</p>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function Watchpoints({ study }: { study: CaseStudy }) {
  return (
    <NumberedListSection
      items={study.watchpoints}
      kicker="What to watch if this recurs"
      heading="Watchpoints"
      id="watchpoints"
    />
  );
}

function RelatedCoins({ study }: { study: CaseStudy }) {
  const related = study.relatedCoins ?? [];
  if (related.length === 0) return null;
  return (
    <RelatedCoinsList
      coins={related}
      kicker="The blast radius"
      heading="Coins caught in the contagion"
      id="related-coins"
    />
  );
}

function Sources({ study }: { study: CaseStudy }) {
  return (
    <section id="sources" className="pharos-subtle-band scroll-mt-32 space-y-4 p-5 sm:p-6">
      <SectionKicker>Primary sources</SectionKicker>
      <ol className="pharos-source-list pharos-source-list-numbered space-y-2.5 text-sm leading-snug text-foreground/90">
        {study.sources.map((source, i) => (
          <li key={i}>
            <a
              href={source.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-baseline gap-1 text-foreground/90 hover:text-brand-accent-text"
            >
              <span>{source.label}</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function CaseStudyBody({ study }: { study: CaseStudy }) {
  const liveWidgets = getLiveChartWidgets(study);
  const navSections = [
    ...(study.takeaways?.length ? [{ id: "key-takeaways", label: "Takeaways" }] : []),
    { id: "peg-on-the-tape", label: liveWidgets.length > 0 ? "Tape" : "Record" },
    { id: "timeline", label: "Timeline" },
    ...study.sections.map((section, index) => ({
      id: caseStudySectionId(index, section.heading),
      label: section.heading,
    })),
    { id: "watchpoints", label: "Watchpoints" },
    ...(study.relatedCoins?.length ? [{ id: "related-coins", label: "Blast radius" }] : []),
    { id: "sources", label: "Sources" },
  ];

  return (
    <>
      <FactStrip study={study} />
      <LongformScrollspyNav
        sections={navSections}
        navAriaLabel="Case study table of contents"
        emphasis="pill-tabs"
        edgeFade
      />
      {study.lead.length > 0 ? (
        <div className="max-w-[68ch] space-y-3 text-base leading-[1.75] text-foreground/90">
          {study.lead.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      ) : null}
      <Takeaways study={study} />
      <HowPharosSawIt study={study} widgets={liveWidgets} />
      <Timeline study={study} />
      <Narrative study={study} />
      <Watchpoints study={study} />
      <RelatedCoins study={study} />
      <Sources study={study} />
      <div className="space-y-8">
        <RelatedStudies study={study} />
        <PrevNextPager study={study} />
        <CrossLinksFooter links={study.crossLinks} />
        <PreferredSourcePrompt />
      </div>
    </>
  );
}
