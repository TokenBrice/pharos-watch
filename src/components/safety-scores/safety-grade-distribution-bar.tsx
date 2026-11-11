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
}: {
  label: string | null;
  denominator: string | null;
  ariaLabel: string;
  legendLabel: string;
  segments: DistributionSegment[];
  compact: boolean;
}) {
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
        role="img"
        aria-label={ariaLabel}
      >
        {segments.map(({ grade, weight, title }, index) => (
          <span
            key={grade}
            className={cn(
              getSafetyGradeMetadata(grade).sectionSwatchClassName,
              index === 0 && "rounded-l-md",
              index === segments.length - 1 && "rounded-r-md",
            )}
            style={{ flexGrow: weight }}
            title={title}
            aria-hidden="true"
          />
        ))}
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-label={legendLabel}>
        {segments.map(({ grade, figure }) => (
          <li key={grade} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn("h-2 w-2 rounded-sm", getSafetyGradeMetadata(grade).sectionSwatchClassName)}
            />
            <span className="pharos-numeric text-sm font-bold text-foreground">{figure}</span>
            <span className="text-3xs font-semibold uppercase text-muted-foreground">{grade}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SupplyRow({ mix }: { mix: SafetyGradeSupplyMix }) {
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
}: {
  gradeCounts: Partial<Record<ReportCardGradeRange, number>>;
  totalCards: number;
  totalLabel?: string;
  supplyMix?: SafetyGradeSupplyMix | null;
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
        <div className="flex items-baseline justify-between gap-3">
          <p className="pharos-label">Grade distribution</p>
          {comparing ? null : (
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
        />
        {supplyMix ? <SupplyRow mix={supplyMix} /> : null}
      </div>
    </div>
  );
}
