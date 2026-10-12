import type { ReactNode } from "react";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function PageLoadingShell({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      {children}
    </div>
  );
}

export function PageLoadingHeader({
  sectionWidth = "w-28",
  titleWidth = "w-64 sm:w-80",
  eyebrowWidth = "w-48",
  includeEyebrow = true,
}: {
  sectionWidth?: string;
  titleWidth?: string;
  eyebrowWidth?: string;
  includeEyebrow?: boolean;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-4 w-20 rounded-sm" />
        <span className="text-xs text-muted-foreground">/</span>
        <Skeleton className={cn("h-4 rounded-sm", sectionWidth)} />
      </div>
      <Skeleton className={cn("h-9 rounded-md sm:h-11", titleWidth)} />
      {includeEyebrow ? <Skeleton className={cn("h-3.5 rounded-sm", eyebrowWidth)} /> : null}
      <Skeleton className="h-4 w-full max-w-2xl rounded-sm" />
    </div>
  );
}

export function PageLoadingStatGrid({
  count,
  className,
  labelWidth = "w-24",
  valueWidth = "w-24",
  valueHeight = "h-8",
}: {
  count: number;
  className: string;
  labelWidth?: string;
  valueWidth?: string;
  valueHeight?: string;
}) {
  return (
    <div className={className}>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="pharos-card-shell space-y-2 p-4">
          <Skeleton className={cn("h-3 rounded-sm", labelWidth)} />
          <Skeleton className={cn("rounded-md", valueHeight, valueWidth)} />
        </div>
      ))}
    </div>
  );
}

/**
 * Placeholder shaped like the rail-page split hero (`FeatureHeroSplit`,
 * `DepegOutlookHero`): answer KPI + universe chip and sub rows on the left,
 * the drawn visual on the right, so a cold load does not jump layouts.
 */
export function PageLoadingSplitHero({ visualClassName }: { visualClassName: string }) {
  return (
    <div className="pharos-card-shell grid grid-cols-1 overflow-hidden lg:grid-cols-3">
      <div className="space-y-5 border-b border-border/50 p-5 sm:p-6 lg:border-b-0 lg:border-r lg:p-7">
        <div className="space-y-2.5">
          <Skeleton className="h-3.5 w-28 rounded-sm" />
          <Skeleton className="h-10 w-32 rounded-md" />
          <Skeleton className="h-6 w-40 rounded-full" />
        </div>
        <div className="space-y-2 border-t border-border/50 pt-4">
          <Skeleton className="h-3 w-24 rounded-sm" />
          <Skeleton className="h-4 w-full rounded-sm" />
          <Skeleton className="h-4 w-4/5 rounded-sm" />
        </div>
      </div>
      <div className={cn("p-5 sm:p-6 lg:col-span-2 lg:p-7", visualClassName)}>
        <Skeleton className="h-full w-full rounded-md" variant="shimmer" />
      </div>
    </div>
  );
}

export function PageLoadingChartBlock({
  className,
  shimmer = false,
}: {
  className: string;
  shimmer?: boolean;
}) {
  if (shimmer) {
    return (
      <div className={cn("pharos-card-shell p-4", className)}>
        <Skeleton className="h-full w-full rounded-md" variant="shimmer" />
      </div>
    );
  }
  return <ChartSkeleton className={className} />;
}

export function PageLoadingRowList({
  rowCount,
  titleWidth = "w-36",
  actionWidth = "w-20",
  avatarClassName = "h-7 w-7 rounded-full",
  primaryWidth = "w-32",
  secondaryWidth = null,
  metricWidths = ["w-16", "w-16", "w-12"],
  metricContainerClassName,
  mobileMetricWidth = null,
  containerClassName = "pharos-card-shell space-y-3 p-4",
  headerClassName = "flex items-center justify-between",
  rowClassName = "py-3",
}: {
  rowCount: number;
  titleWidth?: string;
  actionWidth?: string | null;
  avatarClassName?: string;
  primaryWidth?: string;
  secondaryWidth?: string | null;
  metricWidths?: readonly string[];
  metricContainerClassName?: string;
  mobileMetricWidth?: string | null;
  containerClassName?: string;
  headerClassName?: string;
  rowClassName?: string;
}) {
  return (
    <div className={containerClassName}>
      <div className={headerClassName}>
        <Skeleton className={cn("h-4 rounded-sm", titleWidth)} />
        {actionWidth ? <Skeleton className={cn("h-7 rounded-full", actionWidth)} /> : null}
      </div>
      <ul className="divide-y divide-border/60">
        {Array.from({ length: rowCount }).map((_, index) => (
          <li key={index} className={cn("flex items-center justify-between gap-3", rowClassName)}>
            <div className="flex min-w-0 items-center gap-3">
              <Skeleton className={avatarClassName} />
              {secondaryWidth ? (
                <div className="space-y-1.5">
                  <Skeleton className={cn("h-3.5 rounded-sm", primaryWidth)} />
                  <Skeleton className={cn("h-3 rounded-sm", secondaryWidth)} />
                </div>
              ) : (
                <Skeleton className={cn("h-3.5 rounded-sm", primaryWidth)} />
              )}
            </div>
            <div className={cn("flex items-center gap-3", metricContainerClassName)}>
              {metricWidths.map((width, metricIndex) => (
                <Skeleton key={`${width}-${metricIndex}`} className={cn("h-4 rounded-sm", width)} />
              ))}
            </div>
            {mobileMetricWidth ? <Skeleton className={cn("h-4 rounded-sm sm:hidden", mobileMetricWidth)} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
