"use client";

import type { ReportCardGradeRange } from "@shared/types/report-card-grade";
import { formatCurrency } from "@shared/lib/format";
import { cn } from "@/lib/utils";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";

const GRADE_RANGES = ["A", "B", "C", "D", "F", "NR"] as const satisfies readonly ReportCardGradeRange[];
const RATED_GRADE_RANGES = ["A", "B", "C", "D", "F"] as const satisfies readonly ReportCardGradeRange[];

/**
 * Supply-weighted grade mix over rated assets. `supplyByGrade` and
 * `totalSupply` sum only observed supply; a rated asset without an observed
 * supply is excluded and disclosed through `ratedCount - observedCount`, never
 * counted as zero.
 */
export interface SafetyGradeSupplyMix {
  supplyByGrade: Record<Exclude<ReportCardGradeRange, "NR">, number>;
  totalSupply: number;
  observedCount: number;
  ratedCount: number;
}

interface DistributionSegment {
  grade: ReportCardGradeRange;
  weight: number;
  figure: string;
  title: string;
}

function DistributionRow({
  label,
  denominator,
  ariaLabel,
  legendLabel,
  segments,
  compact,
  activeGrade,
  onSelectGrade,
}: {
  label: string | null;
  denominator: string | null;
  ariaLabel: string;
  legendLabel: string;
  segments: DistributionSegment[];
  compact: boolean;
  activeGrade?: ReportCardGradeRange | null;
  onSelectGrade?: (grade: ReportCardGradeRange) => void;
}) {
  const interactive = onSelectGrade !== undefined;
  const hasSelection = activeGrade != null;

  return (
    <div className="space-y-2">
      {label ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-xs font-medium text-foreground">{label}</p>
          {denominator ? <p className="pharos-numeric text-xs text-muted-foreground">{denominator}</p> : null}
        </div>
      ) : null}
      <div
        className={cn("flex w-full gap-0.5 overflow-hidden rounded-md bg-background/70", compact ? "h-8" : "h-10")}
        role={interactive ? "group" : "img"}
        aria-label={ariaLabel}
      >
        {segments.map(({ grade, weight, figure, title }, index) => {
          const isSelected = activeGrade === grade;
          const swatchClass = getSafetyGradeMetadata(grade).sectionSwatchClassName;
          const segmentClasses = cn(
            swatchClass,
            index === 0 && "rounded-l-md",
            index === segments.length - 1 && "rounded-r-md",
            interactive && "pharos-focus-ring cursor-pointer transition-opacity focus-visible:z-10",
            interactive && hasSelection && !isSelected && "opacity-35 hover:opacity-75",
            interactive && isSelected && "ring-2 ring-inset ring-foreground/80",
          );

          if (!interactive) {
            return (
              <span
                key={grade}
                className={segmentClasses}
                style={{ flexGrow: weight }}
                title={title}
                aria-hidden="true"
              />
            );
          }

          return (
            <button
              key={grade}
              type="button"
              className={segmentClasses}
              style={{ flexGrow: weight }}
              title={`${title} (click to filter)`}
              aria-label={`Filter by grade ${grade} (${figure})`}
              aria-pressed={isSelected}
              onClick={() => onSelectGrade(grade)}
            />
          );
        })}
      </div>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-label={legendLabel}>
        {segments.map(({ grade, figure, title }) => {
          const isSelected = activeGrade === grade;
          if (!interactive) {
            return (
              <li key={grade} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn("h-2 w-2 rounded-sm", getSafetyGradeMetadata(grade).sectionSwatchClassName)}
                />
                <span className="pharos-numeric text-sm font-bold text-foreground">{figure}</span>
                <span className="text-3xs font-semibold uppercase text-muted-foreground">{grade}</span>
              </li>
            );
          }

          return (
            <li key={grade}>
              <button
                type="button"
                aria-pressed={isSelected}
                aria-label={`Filter by grade ${grade}: ${figure}`}
                title={`${title} (click to filter)`}
                onClick={() => onSelectGrade(grade)}
                className={cn(
                  "pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/60 sm:min-h-7 sm:py-0.5",
                  isSelected && "bg-muted ring-1 ring-border",
                  hasSelection && !isSelected && "opacity-60 hover:opacity-100",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn("h-2 w-2 rounded-sm", getSafetyGradeMetadata(grade).sectionSwatchClassName)}
                />
                <span className="pharos-numeric text-sm font-bold text-foreground">{figure}</span>
                <span className="text-3xs font-semibold uppercase text-muted-foreground">{grade}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SupplyRow({
  mix,
  activeGrade,
  onSelectGrade,
}: {
  mix: SafetyGradeSupplyMix;
  activeGrade?: ReportCardGradeRange | null;
  onSelectGrade?: (grade: ReportCardGradeRange) => void;
}) {
  const { supplyByGrade, totalSupply, observedCount, ratedCount } = mix;
  const unobservedCount = ratedCount - observedCount;
  const partial = observedCount > 0 && unobservedCount > 0;

  // Unknown is never drawn as an empty or zero bar: no observed supply, or an
  // observed total of zero (shares undefined), degrades to a dashed strip.
  if (observedCount === 0 || totalSupply <= 0) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-xs font-medium text-foreground">By supply</p>
          <p className="pharos-numeric text-xs text-muted-foreground">{ratedCount} rated</p>
        </div>
        <p className="flex h-8 items-center justify-center rounded-md border border-dashed border-border px-3 text-center text-xs text-muted-foreground">
          {observedCount === 0
            ? "Supply unavailable"
            : `Observed supply is ${formatCurrency(0)}, so supply shares are undefined`}
        </p>
      </div>
    );
  }

  const segments = RATED_GRADE_RANGES.flatMap((grade): DistributionSegment[] => {
    const supply = supplyByGrade[grade];
    if (supply <= 0) return [];
    const share = (supply / totalSupply) * 100;
    const figure = share < 1 ? "<1%" : share > 99 && share < 100 ? ">99%" : `${Math.round(share)}%`;
    return [{ grade, weight: share, figure, title: `Grade ${grade}: ${figure} · ${formatCurrency(supply)}` }];
  });

  return (
    <div className="space-y-2">
      <DistributionRow
        label={partial ? "By known supply" : "By supply"}
        denominator={`${formatCurrency(totalSupply)} · ${partial ? `${observedCount} of ${ratedCount}` : ratedCount} rated`}
        ariaLabel={partial ? "Safety grade distribution by known supply of rated assets" : "Safety grade distribution by supply of rated assets"}
        legendLabel="Grade distribution supply shares"
        segments={segments}
        compact
        activeGrade={activeGrade}
        onSelectGrade={onSelectGrade}
      />
      {partial ? (
        <p className="text-2xs text-muted-foreground">
          Supply unavailable for {unobservedCount} rated {unobservedCount === 1 ? "asset" : "assets"}: excluded, not
          counted as zero.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Compact A/B/C/D/F/NR distribution using the canonical safety-grade colors.
 * With `supplyMix`, a supply-weighted row of rated assets sits under the
 * asset-count row so both readings share one scale and legend order.
 */
export function SafetyGradeDistributionBar({
  gradeCounts,
  totalCards,
  totalLabel = "assets",
  supplyMix,
  activeGrade = null,
  onSelectGrade,
}: {
  gradeCounts: Partial<Record<ReportCardGradeRange, number>>;
  totalCards: number;
  totalLabel?: string;
  supplyMix?: SafetyGradeSupplyMix | null;
  activeGrade?: ReportCardGradeRange | null;
  onSelectGrade?: (grade: ReportCardGradeRange) => void;
}) {
  const segments = GRADE_RANGES.flatMap((grade): DistributionSegment[] => {
    const count = gradeCounts[grade] ?? 0;
    return count > 0 ? [{ grade, weight: count, figure: String(count), title: `Grade ${grade}: ${count}` }] : [];
  });

  if (totalCards === 0 || segments.length === 0) return null;
  const comparing = supplyMix != null;

  return (
    <div className="pharos-chart-stage">
      <div className={comparing ? "space-y-4" : "space-y-3"}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="pharos-label">Grade distribution</p>
          {onSelectGrade ? (
            <p className="text-2xs text-muted-foreground">
              {activeGrade ? `Filtered to Grade ${activeGrade}` : "Select a grade to filter"}
            </p>
          ) : comparing ? null : (
            <p className="pharos-numeric text-xs text-muted-foreground">
              {totalCards} {totalLabel}
            </p>
          )}
        </div>
        <DistributionRow
          label={comparing ? "By asset count" : null}
          denominator={`${totalCards} ${totalLabel}`}
          ariaLabel="Safety grade distribution by asset count"
          legendLabel="Grade distribution counts"
          segments={segments}
          compact={comparing}
          activeGrade={activeGrade}
          onSelectGrade={onSelectGrade}
        />
        {supplyMix ? (
          <SupplyRow
            mix={supplyMix}
            activeGrade={activeGrade}
            onSelectGrade={onSelectGrade}
          />
        ) : null}
      </div>
    </div>
  );
}
