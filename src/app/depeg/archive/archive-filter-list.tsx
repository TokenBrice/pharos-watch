"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { FilterSearchInput } from "@/components/filter-search-input";
import { deviationColorClass } from "@/lib/severity-colors";
import { DEPEG_ARCHIVE_RETIRED_BADGE, DEPEG_AUDIT_DISPUTED_BADGE } from "@shared/lib/classification";

export interface ArchiveEventItem {
  slug: string;
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  monthLabel: string;
  dateLabel: string;
  peakBps: number;
  peakFormatted: string;
  peerMedianPeak: boolean;
  unverifiedPeak: boolean;
  isRetired: boolean;
  isDisputed: boolean;
}

type DirectionFilter = "all" | "below" | "above";
type SeverityFilter = "all" | "1000" | "2500" | "5000";

const DIRECTION_OPTIONS: ReadonlyArray<{ value: DirectionFilter; label: string }> = [
  { value: "all", label: "All directions" },
  { value: "below", label: "Below peg" },
  { value: "above", label: "Above peg" },
];

const SEVERITY_OPTIONS: ReadonlyArray<{ value: SeverityFilter; label: string }> = [
  { value: "all", label: "All sizes" },
  { value: "1000", label: "10%+" },
  { value: "2500", label: "25%+" },
  { value: "5000", label: "50%+" },
];

const AUDIT_BADGE_CLASS =
  "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-3xs font-medium leading-none";

function groupItemsByMonth(items: readonly ArchiveEventItem[]): Array<{ label: string; items: ArchiveEventItem[] }> {
  const groups: Array<{ label: string; items: ArchiveEventItem[] }> = [];
  for (const item of items) {
    const current = groups[groups.length - 1];
    if (current && current.label === item.monthLabel) current.items.push(item);
    else groups.push({ label: item.monthLabel, items: [item] });
  }
  return groups;
}

/**
 * Client-side filter bar over the complete server-rendered permanent event list.
 * Default state renders every permanent event link in SSR HTML so the crawlable
 * link hub stays 100% intact.
 */
export function DepegArchiveFilterList({ items }: { items: readonly ArchiveEventItem[] }) {
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [severity, setSeverity] = useState<SeverityFilter>("all");

  const minBps = severity === "all" ? 0 : Number(severity);
  const filtersActive = search.trim().length > 0 || direction !== "all" || severity !== "all";

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (direction !== "all" && item.direction !== direction) return false;
      if (minBps > 0 && item.peakBps < minBps) return false;
      if (q) {
        const matchesSymbol = item.symbol.toLowerCase().includes(q);
        const matchesId = item.stablecoinId.toLowerCase().includes(q);
        const matchesSlug = item.slug.toLowerCase().includes(q);
        if (!matchesSymbol && !matchesId && !matchesSlug) return false;
      }
      return true;
    });
  }, [items, search, direction, minBps]);

  const groups = useMemo(() => groupItemsByMonth(filteredItems), [filteredItems]);

  const clearFilters = () => {
    setSearch("");
    setDirection("all");
    setSeverity("all");
  };

  return (
    <div className="space-y-4">
      <div className="pharos-card-shell flex flex-wrap items-center gap-2 p-3">
        <FilterSearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="Filter by coin..."
          className="relative w-full sm:w-48"
          inputClassName="pl-8 h-11 md:h-8 text-xs"
          ariaLabel="Search archived depeg events by coin symbol"
        />
        <ControlPillToggle
          variant="segmented"
          options={DIRECTION_OPTIONS}
          value={direction}
          onChange={setDirection}
          ariaLabel="Filter archive by direction"
          buttonClassName="min-h-11 sm:min-h-8"
        />
        <ControlPillToggle
          variant="segmented"
          options={SEVERITY_OPTIONS}
          value={severity}
          onChange={setSeverity}
          ariaLabel="Filter archive by severity"
          buttonClassName="min-h-11 sm:min-h-8"
        />
        {filtersActive ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="pharos-meta pharos-numeric">
              Showing {filteredItems.length} of {items.length}
            </span>
            <button
              type="button"
              onClick={clearFilters}
              className="pharos-focus-ring pharos-control-pill gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Clear filters
            </button>
          </div>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <div className="pharos-empty-note text-center">
          <p>No archived events match these filters.</p>
          {filtersActive ? (
            <button
              type="button"
              onClick={clearFilters}
              className="pharos-focus-ring pharos-control-pill mt-3 gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Clear filters
            </button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.label} className="space-y-1.5">
              <h3 className="pharos-label">{group.label}</h3>
              <ul className="pharos-card-shell divide-y divide-border/60">
                {group.items.map((event) => {
                  const arrow = event.direction === "above" ? "↑" : "↓";
                  return (
                    <li key={event.slug}>
                      <Link
                        href={`/depeg/${event.slug}/`}
                        className="pharos-focus-ring flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2.5 text-sm hover:bg-muted/40 sm:gap-x-3"
                      >
                        <span className="pharos-numeric text-xs text-muted-foreground">
                          {event.dateLabel}
                        </span>
                        <span className="font-semibold text-foreground">
                          {event.symbol}
                        </span>
                        {event.isRetired ? (
                          <span className={`${AUDIT_BADGE_CLASS} ${DEPEG_ARCHIVE_RETIRED_BADGE.className}`}>
                            {DEPEG_ARCHIVE_RETIRED_BADGE.label}
                          </span>
                        ) : null}
                        {event.isDisputed ? (
                          <span className={`${AUDIT_BADGE_CLASS} ${DEPEG_AUDIT_DISPUTED_BADGE.className}`}>
                            {DEPEG_AUDIT_DISPUTED_BADGE.label}
                          </span>
                        ) : null}
                        <span className={`pharos-numeric text-xs ${deviationColorClass(event.peakBps)}`}>
                          {arrow} {event.peakFormatted}
                          {event.peerMedianPeak ? " from peer median · Lower confidence" : ""}
                          {event.unverifiedPeak ? " · Peak unverified" : ""}
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground hover:text-foreground">
                          <span className="hidden sm:inline">View page </span>→
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
