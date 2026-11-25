"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { MechanismArchetype } from "@shared/types/stablecoin-taxonomy";
import type { CaseStudyOutcome } from "@shared/types/editorial-content";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { cn } from "@/lib/utils";
import {
  CASE_STUDY_OUTCOME_CHIP_BASE,
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "@/lib/case-study-outcomes";
import { formatSignedBps } from "./case-study-format";

/**
 * Serializable subset of `CaseStudy` passed from the server `page.tsx`. The full
 * `CaseStudy` carries no functions, but we keep the prop surface minimal so the
 * client bundle only ships what the hub list actually renders.
 */
export interface CaseStudyListItem {
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string;
  readonly eyebrow: string;
  readonly archetype: MechanismArchetype;
  readonly outcome: CaseStudyOutcome;
  readonly eventDateLabel: string;
  readonly eventStartISO: string;
  readonly peakDeviationBps: number | null;
  readonly lowPrice: number | null;
  readonly metricScope: string | null;
  readonly readingMinutes: number;
  readonly primaryCoinLogoSrc: string | null;
  readonly primaryCoinSymbol: string | null;
}

export interface PriorityCaseStudySummary {
  readonly outcome: CaseStudyOutcome;
  readonly archetype: MechanismArchetype;
}

type OutcomeFilter = CaseStudyOutcome | "all";
type ArchetypeFilter = MechanismArchetype | "all";
type SortOrder = "curated" | "newest" | "deepest";

const OUTCOME_FILTERS: ReadonlyArray<{ value: OutcomeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "survived", label: CASE_STUDY_OUTCOME_LABELS.survived },
  { value: "wounded", label: CASE_STUDY_OUTCOME_LABELS.wounded },
  { value: "died", label: CASE_STUDY_OUTCOME_LABELS.died },
];

const SORT_OPTIONS: ReadonlyArray<{ value: SortOrder; label: string }> = [
  { value: "curated", label: "Curated" },
  { value: "newest", label: "Newest" },
  { value: "deepest", label: "Deepest depeg" },
];

const VALID_OUTCOMES = new Set<OutcomeFilter>(["all", "survived", "wounded", "died"]);
const VALID_SORTS = new Set<SortOrder>(["curated", "newest", "deepest"]);

function depegMagnitudeScore(study: CaseStudyListItem): number {
  if (study.peakDeviationBps != null) return Math.abs(study.peakDeviationBps);
  if (study.lowPrice != null) return Math.round(Math.abs(study.lowPrice - 1) * 10_000);
  return -1;
}

export function CaseStudyList({
  studies,
  archetypeLabels,
  priorityStudies = [],
}: {
  studies: readonly CaseStudyListItem[];
  /** Resolved on the server so the shared classification module stays out of the client import path. */
  archetypeLabels: Record<MechanismArchetype, string>;
  /** Metadata for the Start here cards excluded from archive rows, so filtered counts stay transparent. */
  priorityStudies?: readonly PriorityCaseStudySummary[];
}) {
  const { getParam, setParam, setParams } = useUrlFilters();

  // Preserve canonical archetype order present in the archive rows.
  const presentArchetypes = useMemo<readonly MechanismArchetype[]>(() => {
    const seen = new Set<MechanismArchetype>();
    const ordered: MechanismArchetype[] = [];
    for (const study of studies) {
      if (!seen.has(study.archetype)) {
        seen.add(study.archetype);
        ordered.push(study.archetype);
      }
    }
    return ordered;
  }, [studies]);

  const rawOutcome = getParam("outcome", "all") as OutcomeFilter;
  const outcome: OutcomeFilter = VALID_OUTCOMES.has(rawOutcome) ? rawOutcome : "all";

  const rawMechanism = getParam("mechanism", "all") as ArchetypeFilter;
  const archetype: ArchetypeFilter =
    rawMechanism === "all" || presentArchetypes.includes(rawMechanism) ? rawMechanism : "all";

  const rawSort = getParam("sort", "curated") as SortOrder;
  const sort: SortOrder = VALID_SORTS.has(rawSort) ? rawSort : "curated";

  const handleOutcomeChange = (next: OutcomeFilter) => {
    setParam("outcome", next);
  };

  const handleArchetypeChange = (next: ArchetypeFilter) => {
    setParam("mechanism", next);
  };

  const handleSortChange = (next: SortOrder) => {
    setParam("sort", next === "curated" ? "" : next);
  };

  const resetFilters = () => {
    setParams({ outcome: "all", mechanism: "all" });
  };

  // Live counts reflect the currently selected outcome filter so empty cells are visible up front.
  const archetypeFilters = useMemo<
    ReadonlyArray<{ value: ArchetypeFilter; label: string; count: number }>
  >(() => {
    const byOutcome = outcome === "all"
      ? studies
      : studies.filter((study) => study.outcome === outcome);
    const counts = new Map<MechanismArchetype, number>();
    for (const study of byOutcome) {
      counts.set(study.archetype, (counts.get(study.archetype) ?? 0) + 1);
    }
    return [
      { value: "all", label: "All", count: byOutcome.length },
      ...presentArchetypes.map((item) => ({
        value: item,
        label: archetypeLabels[item],
        count: counts.get(item) ?? 0,
      })),
    ];
  }, [studies, outcome, presentArchetypes, archetypeLabels]);

  const visible = useMemo(() => {
    const filtered = studies.filter(
      (study) =>
        (outcome === "all" || study.outcome === outcome) &&
        (archetype === "all" || study.archetype === archetype),
    );
    if (sort === "curated") return filtered;
    const indexed = filtered.map((study, index) => ({ study, index }));
    if (sort === "newest") {
      indexed.sort(
        (a, b) =>
          (Date.parse(b.study.eventStartISO) || 0) - (Date.parse(a.study.eventStartISO) || 0) ||
          a.index - b.index,
      );
    } else if (sort === "deepest") {
      indexed.sort(
        (a, b) =>
          depegMagnitudeScore(b.study) - depegMagnitudeScore(a.study) ||
          a.index - b.index,
      );
    }
    return indexed.map((entry) => entry.study);
  }, [studies, outcome, archetype, sort]);

  const matchingPriorityCount = useMemo(
    () =>
      priorityStudies.filter(
        (study) =>
          (outcome === "all" || study.outcome === outcome) &&
          (archetype === "all" || study.archetype === archetype),
      ).length,
    [priorityStudies, outcome, archetype],
  );

  const isFiltered = outcome !== "all" || archetype !== "all";

  return (
    <div className="space-y-6">
      <div
        className="flex flex-col gap-4 border-b border-border/60 pb-5"
        role="group"
        aria-label="Filter and sort case studies"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="pharos-label">Outcome</p>
            <ControlPillToggle
              variant="segmented"
              ariaLabel="Filter by outcome"
              options={OUTCOME_FILTERS}
              value={outcome}
              onChange={handleOutcomeChange}
              buttonClassName="min-h-11 sm:min-h-8"
            />
          </div>
          <div className="flex flex-col gap-2">
            <p className="pharos-label">Sort</p>
            <ControlPillToggle
              variant="segmented"
              ariaLabel="Sort case studies"
              options={SORT_OPTIONS}
              value={sort}
              onChange={handleSortChange}
              buttonClassName="min-h-11 sm:min-h-8"
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <p className="pharos-label">Mechanism</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by mechanism">
            {archetypeFilters.map((filter) => {
              const active = archetype === filter.value;
              return (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handleArchetypeChange(filter.value)}
                  className={cn(
                    "pharos-focus-ring pharos-control-pill min-h-11 gap-1.5 sm:min-h-9",
                    active && "pharos-control-pill-active",
                    !active && filter.count === 0 && "opacity-60",
                  )}
                >
                  <span>{filter.label}</span>{" "}
                  <span className="pharos-numeric text-2xs text-muted-foreground">
                    {filter.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div
          className="pharos-empty-note flex flex-wrap items-center justify-between gap-3"
          aria-live="polite"
        >
          <p>
            No archive case studies match these filters.
            {matchingPriorityCount > 0 ? (
              <>
                {" "}
                <a href="#start-here" className="pharos-prose-link text-foreground">
                  View{" "}
                  <span className="pharos-numeric">{matchingPriorityCount}</span> matching{" "}
                  {matchingPriorityCount === 1 ? "primer" : "primers"} in Start here
                </a>
                .
              </>
            ) : null}
          </p>
          <button
            type="button"
            onClick={resetFilters}
            className="pharos-focus-ring pharos-control-pill min-h-11 sm:min-h-8"
          >
            Reset filters
          </button>
        </div>
      ) : (
        <>
          <p className="pharos-meta flex flex-wrap items-center gap-x-2 gap-y-1" aria-live="polite">
            <span>
              <span className="pharos-numeric font-medium text-foreground">{visible.length}</span>{" "}
              archive {visible.length === 1 ? "study" : "studies"}
            </span>
            {!isFiltered && priorityStudies.length > 0 ? (
              <>
                <span aria-hidden="true" className="text-muted-foreground/50">·</span>
                <a href="#start-here" className="pharos-prose-link">
                  <span className="pharos-numeric">{priorityStudies.length}</span> reflexive-collapse primers above
                </a>
              </>
            ) : isFiltered && matchingPriorityCount > 0 ? (
              <a href="#start-here" className="pharos-prose-link">
                (+<span className="pharos-numeric">{matchingPriorityCount}</span> in Start here)
              </a>
            ) : null}
          </p>
          <ol className="divide-y divide-border/60">
            {visible.map((study) => (
              <li key={study.slug}>
                <Link
                  href={`/learn/case-studies/${study.slug}/`}
                  className="pharos-focus-ring group -mx-3 grid gap-4 rounded-xl px-3 py-5 transition-colors hover:bg-muted/35 sm:py-6 lg:grid-cols-[minmax(0,1fr)_13rem_auto] lg:items-start lg:gap-8"
                >
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {study.primaryCoinLogoSrc ? (
                        <img
                          src={study.primaryCoinLogoSrc}
                          alt=""
                          aria-hidden="true"
                          width={20}
                          height={20}
                          className="h-5 w-5 shrink-0 rounded-full"
                          loading="lazy"
                        />
                      ) : null}
                      <p className="pharos-label">{study.eyebrow}</p>
                      {study.primaryCoinSymbol ? (
                        <>
                          <span aria-hidden="true" className="text-xs text-muted-foreground/50">·</span>
                          <span className="pharos-numeric text-xs font-medium text-muted-foreground">
                            {study.primaryCoinSymbol}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <h2 className="pharos-display text-xl font-bold tracking-tight text-foreground transition-colors group-hover:text-brand-accent-text sm:text-2xl">
                      {study.title}
                    </h2>
                    <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground sm:text-base">
                      {study.subtitle}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 pharos-meta">
                      <span className="pharos-numeric text-foreground/85">{study.eventDateLabel}</span>
                      <span aria-hidden="true" className="text-muted-foreground/50">·</span>
                      <span>{archetypeLabels[study.archetype]}</span>
                      <span aria-hidden="true" className="text-muted-foreground/50">·</span>
                      <span>
                        <span className="pharos-numeric">~{study.readingMinutes}</span> min read
                      </span>
                      <span className="inline-flex flex-wrap items-center gap-2 lg:hidden">
                        <span
                          className={cn(
                            CASE_STUDY_OUTCOME_CHIP_BASE,
                            CASE_STUDY_OUTCOME_CHIPS[study.outcome],
                          )}
                        >
                          {CASE_STUDY_OUTCOME_LABELS[study.outcome]}
                        </span>
                        {study.peakDeviationBps != null ? (
                          <span className="pharos-numeric text-xs font-medium text-foreground">
                            {formatSignedBps(study.peakDeviationBps)}
                          </span>
                        ) : study.lowPrice != null ? (
                          <span className="pharos-numeric text-xs font-medium text-foreground">
                            low ${study.lowPrice.toFixed(3)}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </div>

                  <div className="hidden flex-col items-end gap-1.5 pt-0.5 text-right lg:flex">
                    <span
                      className={cn(
                        CASE_STUDY_OUTCOME_CHIP_BASE,
                        CASE_STUDY_OUTCOME_CHIPS[study.outcome],
                      )}
                    >
                      {CASE_STUDY_OUTCOME_LABELS[study.outcome]}
                    </span>
                    <div className="space-y-0.5">
                      <p className="pharos-label">Peak deviation</p>
                      <p className="pharos-numeric text-sm font-semibold text-foreground">
                        {study.peakDeviationBps != null ? formatSignedBps(study.peakDeviationBps) : "—"}
                      </p>
                      <p className="pharos-meta">
                        Low print:{" "}
                        <span className="pharos-numeric text-foreground/85">
                          {study.lowPrice != null ? `$${study.lowPrice.toFixed(3)}` : "—"}
                        </span>
                      </p>
                      {study.metricScope ? (
                        <p className="text-2xs leading-snug text-muted-foreground">
                          Scope: {study.metricScope}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <span className="hidden items-start pt-1 text-muted-foreground transition-colors group-hover:text-foreground lg:inline-flex">
                    <ArrowUpRight
                      className="h-5 w-5 transition-transform group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
