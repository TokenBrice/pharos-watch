"use client";

import type { ReportCardGradeRange } from "@shared/lib/report-cards";
import { cn } from "@/lib/utils";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";

const GRADE_RANGES = ["A", "B", "C", "D", "F", "NR"] as const satisfies readonly ReportCardGradeRange[];

/** Compact A/B/C/D/F/NR distribution using the canonical safety-grade colors. */
export function SafetyGradeDistributionBar({
  gradeCounts,
  totalCards,
  totalLabel = "rated",
}: {
  gradeCounts: Partial<Record<ReportCardGradeRange, number>>;
  totalCards: number;
  totalLabel?: string;
}) {
  const segments = GRADE_RANGES.map((grade) => ({ grade, count: gradeCounts[grade] ?? 0 })).filter(
    (segment) => segment.count > 0,
  );

  if (totalCards === 0 || segments.length === 0) return null;

  return (
    <div className="pharos-chart-stage">
      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="pharos-kicker">Grade distribution</p>
          <p className="pharos-numeric text-xs text-muted-foreground">
            {totalCards} {totalLabel}
          </p>
        </div>

        <div
          className="flex h-10 w-full gap-0.5 overflow-hidden rounded-md bg-background/70"
          role="img"
          aria-label="Safety grade distribution by asset count"
        >
          {segments.map(({ grade, count }, index) => (
            <span
              key={grade}
              className={cn(
                getSafetyGradeMetadata(grade).sectionSwatchClassName,
                index === 0 && "rounded-l-md",
                index === segments.length - 1 && "rounded-r-md",
              )}
              style={{ flexGrow: count }}
              title={`Grade ${grade}: ${count}`}
              aria-hidden="true"
            />
          ))}
        </div>

        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-label="Grade distribution counts">
          {segments.map(({ grade, count }) => (
            <li key={grade} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn("h-2 w-2 rounded-sm", getSafetyGradeMetadata(grade).sectionSwatchClassName)}
              />
              <span className="pharos-numeric text-sm font-bold text-foreground">{count}</span>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{grade}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
