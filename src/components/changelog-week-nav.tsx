"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

interface ChangelogWeekNavProps {
  entries: { dateRange: { from: string; to: string } }[];
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface MonthGroup {
  /** `YYYY-MM` key for the month. */
  key: string;
  year: number;
  label: string;
  /** Anchor id (a changelog entry's `to` date) of the newest entry in the month. */
  anchorId: string;
}

/**
 * Reverse-chronological jump index for the changelog. Entries arrive weekly and
 * unbounded, so a per-week row eventually overflows any single lane. We collapse
 * weeks into month chips (the natural archive granularity) and let them wrap
 * instead of scroll — every period stays reachable without a hidden scroller,
 * and the count grows ~12/year rather than ~52. Week-level detail still lives in
 * the body timeline below.
 */
export function ChangelogWeekNav({ entries }: ChangelogWeekNavProps) {
  const { months, entryMonthKey } = useMemo(() => {
    const months: MonthGroup[] = [];
    const entryMonthKey = new Map<string, string>();
    const seen = new Set<string>();

    // `entries` is newest-first, so the first entry seen for a month is its newest.
    for (const { dateRange } of entries) {
      const to = dateRange.to;
      const key = to.slice(0, 7);
      entryMonthKey.set(to, key);
      if (seen.has(key)) continue;
      seen.add(key);
      months.push({
        key,
        year: Number(to.slice(0, 4)),
        label: MONTH_LABELS[Number(to.slice(5, 7)) - 1],
        anchorId: to,
      });
    }
    return { months, entryMonthKey };
  }, [entries]);

  const multiYear = new Set(months.map((m) => m.year)).size > 1;

  const idSignature = entries.map((e) => e.dateRange.to).join("|");
  const [activeMonthKey, setActiveMonthKey] = useState(months[0]?.key ?? "");

  useEffect(() => {
    const ids = idSignature.split("|").filter(Boolean);
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    const visibleIds = new Set<string>();

    const observer = new IntersectionObserver(
      (observerEntries) => {
        for (const entry of observerEntries) {
          if (entry.isIntersecting) {
            visibleIds.add(entry.target.id);
          } else {
            visibleIds.delete(entry.target.id);
          }
        }

        for (const id of ids) {
          if (visibleIds.has(id)) {
            const key = entryMonthKey.get(id);
            if (key) setActiveMonthKey(key);
            return;
          }
        }
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: [0.05, 0.2] },
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [idSignature, entryMonthKey]);

  return (
    <nav aria-label="Jump to release" className="text-xs">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
        <span className="shrink-0 pl-1 text-xs font-medium text-muted-foreground">
          Jump to:
        </span>
        {months.map((month, i) => {
          const isActive = activeMonthKey === month.key;
          const isLatest = i === 0;
          const showYear =
            multiYear && (i === 0 || months[i - 1].year !== month.year);

          return (
            <span key={month.key} className="contents">
              {showYear && (
                <span className="pharos-numeric shrink-0 pl-1 pr-0.5 text-[11px] font-medium text-muted-foreground/70">
                  {month.year}
                </span>
              )}
              <a
                href={`#${month.anchorId}`}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "pharos-focus-ring pharos-control-pill gap-2 whitespace-nowrap",
                  isActive && "pharos-control-pill-active",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full transition-colors",
                    isActive
                      ? "bg-current"
                      : "border border-border/80 bg-transparent",
                  )}
                  aria-hidden
                />
                <span className="pharos-numeric">{month.label}</span>
                {isLatest && (
                  <span className="inline-flex items-center rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px] font-sans font-semibold uppercase tracking-wider text-foreground">
                    Latest
                  </span>
                )}
              </a>
            </span>
          );
        })}
      </div>
    </nav>
  );
}
