import { useState } from "react";
import { CAUSE_META, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { MECHANISM_ARCHETYPE_SHORT_LABELS } from "@shared/lib/classification";
import { FilterSearchInput } from "@/components/filter-search-input";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import {
  CEMETERY_PEAK_BUCKET_LABELS,
  CEMETERY_RECORD_FILTER_LABELS,
  type CemeteryRegisterFilters,
} from "@/lib/cemetery-selection";
import type { CemeteryStats } from "@/lib/cemetery-stats";
import { cn } from "@/lib/utils";
import { CemeteryRegisterCauseDot } from "./cemetery-register-cause-dot";

export type RegisterFacetKey = "year" | "peg" | "mechanism" | "record" | "peak";

interface FacetOption {
  value: string;
  label: string;
  /** Global count across every record, so the numbers stay stable while filtering. */
  count: number;
}

export interface RegisterFilterOptions {
  total: number;
  causes: { cause: CauseOfDeath; count: number }[];
  facets: Record<RegisterFacetKey, FacetOption[]>;
}

/** Filter choices with global counts, from the page stats plus the projected rows. */
export function buildRegisterFilterOptions(stats: CemeteryStats, rows: readonly CemeteryRegisterRow[]): RegisterFilterOptions {
  const pegCounts = new Map<string, number>();
  for (const row of rows) pegCounts.set(row.pegCurrency, (pegCounts.get(row.pegCurrency) ?? 0) + 1);

  return {
    total: stats.total,
    causes: stats.causes.map(({ cause, count }) => ({ cause, count })),
    facets: {
      year: stats.years
        .filter((year) => year.total > 0)
        .map((year) => ({ value: String(year.year), label: String(year.year), count: year.total }))
        .reverse(),
      peg: [...pegCounts]
        .sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : a > b ? 1 : 0))
        .map(([peg, count]) => ({ value: peg, label: peg, count })),
      mechanism: stats.mechanisms.counts.map(({ archetype, count }) => ({
        value: archetype,
        label: MECHANISM_ARCHETYPE_SHORT_LABELS[archetype],
        count,
      })),
      record: [
        { value: "tracked", label: CEMETERY_RECORD_FILTER_LABELS.tracked, count: stats.trackedCount },
        { value: "curated", label: CEMETERY_RECORD_FILTER_LABELS.curated, count: stats.curatedCount },
        {
          value: "case-study",
          label: CEMETERY_RECORD_FILTER_LABELS["case-study"],
          count: rows.filter((row) => row.caseStudy !== null).length,
        },
      ],
      peak: stats.peakBuckets.map(({ key, count }) => ({ value: key, label: CEMETERY_PEAK_BUCKET_LABELS[key], count })),
    },
  };
}

const FACETS: readonly { key: RegisterFacetKey; label: string; allLabel: string }[] = [
  { key: "year", label: "Year", allLabel: "All years" },
  { key: "peg", label: "Peg", allLabel: "All pegs" },
  { key: "mechanism", label: "Mechanism", allLabel: "All mechanisms" },
  { key: "record", label: "Record", allLabel: "All records" },
  { key: "peak", label: "Peak", allLabel: "All sizes" },
];

const PILL_CLASS = "pharos-focus-ring pharos-control-pill min-h-11 gap-1.5 md:min-h-9";

export interface CemeteryRegisterToolbarProps {
  filters: CemeteryRegisterFilters;
  filtersActive: boolean;
  queryValue: string;
  resultLine: string;
  options: RegisterFilterOptions;
  onQueryChange: (value: string) => void;
  onCauseChange: (cause: CauseOfDeath | undefined) => void;
  onFacetChange: (key: RegisterFacetKey, value: string) => void;
  onReset: () => void;
}

export function CemeteryRegisterToolbar({
  filters,
  filtersActive,
  queryValue,
  resultLine,
  options,
  onQueryChange,
  onCauseChange,
  onFacetChange,
  onReset,
}: CemeteryRegisterToolbarProps) {
  const [facetsOpen, setFacetsOpen] = useState(false);
  const activeFacetCount = FACETS.filter(({ key }) => filters[key] !== undefined).length;

  return (
    <div className="pharos-table-toolbar">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <FilterSearchInput
          value={queryValue}
          onValueChange={onQueryChange}
          placeholder="Search name, ticker, or epitaph"
          ariaLabel="Search name, ticker, id, or epitaph"
          className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 md:max-w-sm"
          inputClassName="h-11 pl-8 text-sm md:h-9"
        />
        <button
          type="button"
          aria-expanded={facetsOpen}
          aria-controls="cemetery-register-facets"
          onClick={() => setFacetsOpen((open) => !open)}
          className={cn(PILL_CLASS, "md:hidden")}
        >
          Filters ({activeFacetCount})
        </button>
        <p className="pharos-numeric ml-auto text-xs text-muted-foreground">{resultLine}</p>
      </div>

      <div role="group" aria-label="Filter by cause" className="flex flex-wrap gap-1.5">
        <button
          id="cemetery-register-cause-all"
          type="button"
          aria-pressed={filters.cause === undefined}
          onClick={() => onCauseChange(undefined)}
          className={cn(PILL_CLASS, filters.cause === undefined && "pharos-control-pill-active")}
        >
          All <span className="pharos-numeric text-[11px] opacity-75">{options.total}</span>
        </button>
        {options.causes.map(({ cause, count }) => (
          <button
            key={cause}
            type="button"
            aria-pressed={filters.cause === cause}
            onClick={() => onCauseChange(cause)}
            className={cn(PILL_CLASS, filters.cause === cause && "pharos-control-pill-active")}
          >
            <CemeteryRegisterCauseDot cause={cause} />
            {CAUSE_META[cause].label} <span className="pharos-numeric text-[11px] opacity-75">{count}</span>
          </button>
        ))}
      </div>

      <div
        id="cemetery-register-facets"
        className={
          facetsOpen
            ? "grid grid-cols-2 gap-x-3 gap-y-2 md:flex md:flex-wrap md:items-center md:gap-x-4"
            : "hidden md:flex md:flex-wrap md:items-center md:gap-x-4 md:gap-y-2"
        }
      >
        {FACETS.map(({ key, label, allLabel }) => {
          const value = filters[key];
          const facetOptions = options.facets[key];
          return (
            <label key={key} className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground md:flex-row md:items-center md:gap-2">
              <span>{label}</span>
              <select
                value={value ?? ""}
                onChange={(event) => onFacetChange(key, event.target.value)}
                className="pharos-focus-ring h-11 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground md:h-8"
              >
                <option value="">{allLabel}</option>
                {facetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} ({option.count})
                  </option>
                ))}
                {value !== undefined && !facetOptions.some((option) => option.value === value) ? (
                  <option value={value}>{value} (0)</option>
                ) : null}
              </select>
            </label>
          );
        })}
        <button
          type="button"
          aria-disabled={!filtersActive}
          onClick={filtersActive ? onReset : undefined}
          className="pharos-prose-link inline-flex min-h-11 items-center self-end text-xs text-muted-foreground aria-disabled:cursor-default aria-disabled:no-underline aria-disabled:opacity-50 md:min-h-0 md:self-auto"
        >
          Reset filters
        </button>
      </div>
    </div>
  );
}
