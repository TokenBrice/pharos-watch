"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { MechanismArchetype } from "@shared/types";
import { cn } from "@/lib/utils";
import { ARCHETYPE_VISUALS } from "../mechanisms/content/types";
import type { CaseStudyOutcome } from "./content/types";
import {
  CASE_STUDY_OUTCOME_CHIP_BASE,
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "./case-study-outcomes";

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
}

type OutcomeFilter = CaseStudyOutcome | "all";
type ArchetypeFilter = MechanismArchetype | "all";

const OUTCOME_FILTERS: ReadonlyArray<{ value: OutcomeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "survived", label: CASE_STUDY_OUTCOME_LABELS.survived },
  { value: "wounded", label: CASE_STUDY_OUTCOME_LABELS.wounded },
  { value: "died", label: CASE_STUDY_OUTCOME_LABELS.died },
];

const SEGMENT_BTN_BASE =
  "pharos-focus-ring inline-flex min-h-9 items-center gap-2 rounded-full border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-[background-color,border-color,color] hover:text-foreground aria-pressed:border-frost-blue/50 aria-pressed:bg-frost-blue/10 aria-pressed:text-foreground";

export function CaseStudyList({
  studies,
  archetypeLabels,
}: {
  studies: readonly CaseStudyListItem[];
  /** Resolved on the server so the shared classification module stays out of the client import path. */
  archetypeLabels: Record<MechanismArchetype, string>;
}) {
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [archetype, setArchetype] = useState<ArchetypeFilter>("all");

  // Only offer archetype chips for archetypes actually present in the archive,
  // preserving the canonical list order.
  const archetypeFilters = useMemo<ReadonlyArray<{ value: ArchetypeFilter; label: string }>>(() => {
    const seen = new Set<MechanismArchetype>();
    const ordered: MechanismArchetype[] = [];
    for (const study of studies) {
      if (!seen.has(study.archetype)) {
        seen.add(study.archetype);
        ordered.push(study.archetype);
      }
    }
    return [
      { value: "all", label: "All" },
      ...ordered.map((a) => ({ value: a, label: archetypeLabels[a] })),
    ];
  }, [studies, archetypeLabels]);

  const visible = useMemo(
    () =>
      studies.filter(
        (study) =>
          (outcome === "all" || study.outcome === outcome) &&
          (archetype === "all" || study.archetype === archetype),
      ),
    [studies, outcome, archetype],
  );

  return (
    <div className="space-y-6">
      <div
        className="flex flex-col gap-4 border-b border-border/60 pb-5"
        role="group"
        aria-label="Filter case studies"
      >
        <div className="flex flex-col gap-2">
          <p className="pharos-kicker">Outcome</p>
          <div className="flex flex-wrap gap-2">
            {OUTCOME_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                aria-pressed={outcome === filter.value}
                onClick={() => setOutcome(filter.value)}
                className={SEGMENT_BTN_BASE}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <p className="pharos-kicker">Mechanism</p>
          <div className="flex flex-wrap gap-2">
            {archetypeFilters.map((filter) => (
              <button
                key={filter.value}
                type="button"
                aria-pressed={archetype === filter.value}
                onClick={() => setArchetype(filter.value)}
                className={SEGMENT_BTN_BASE}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-sm text-muted-foreground" aria-live="polite">
          No case studies match these filters yet.
        </p>
      ) : (
        <>
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground" aria-live="polite">
            {visible.length} case {visible.length === 1 ? "study" : "studies"}
          </p>
          <ol className="divide-y divide-border/60">
          {visible.map((study) => (
            <li key={study.slug}>
              <Link
                href={`/learn/case-studies/${study.slug}/`}
                className="pharos-focus-ring group grid gap-3 py-8 xl:grid-cols-[minmax(0,1fr)_auto] xl:gap-12 xl:py-10"
              >
                <div className="flex flex-col gap-3">
                  <p
                    className={cn(
                      "pharos-kicker",
                      ARCHETYPE_VISUALS[study.archetype].kickerClass,
                    )}
                  >
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
                    <span>{archetypeLabels[study.archetype]}</span>
                    <span
                      className={cn(
                        CASE_STUDY_OUTCOME_CHIP_BASE,
                        CASE_STUDY_OUTCOME_CHIPS[study.outcome],
                      )}
                    >
                      {CASE_STUDY_OUTCOME_LABELS[study.outcome]}
                    </span>
                  </div>
                </div>
                <span className="hidden items-start pt-1 text-frost-blue opacity-70 transition-opacity group-hover:opacity-100 xl:inline-flex">
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
