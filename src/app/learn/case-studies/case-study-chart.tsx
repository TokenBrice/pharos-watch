"use client";

import { useSupplyHistory } from "@/hooks/use-stablecoins";
import { PegDeviationChart } from "@/components/peg-deviation-chart";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import type {
  CaseStudyDataWidget,
  CaseStudyEventWindow,
} from "@shared/types/editorial-content";
import { getCaseStudyChartDays } from "@/lib/case-study-event-window";

/**
 * Live Pharos peg-deviation chart embedded in a case study. Hydrates
 * client-side via `useSupplyHistory` (fine under static export). Only rendered
 * for data-rich coins where a real series exists; historical pre-collection
 * events omit `dataWidgets`. Event annotation overlays are retired.
 */
export function CaseStudyChart({
  widget,
  eventWindows,
}: {
  widget: CaseStudyDataWidget;
  eventWindows: readonly CaseStudyEventWindow[];
}) {
  const { data, error, isLoading } = useSupplyHistory(
    widget.coinId,
    getCaseStudyChartDays(eventWindows),
  );
  const hasData = data.some((point) => point.price != null && point.price > 0);
  const pending = isLoading && !hasData;

  return (
    <figure className="pharos-card-shell overflow-hidden">
      {error && !hasData ? (
        <div className="px-4 pt-4 sm:px-6">
          <QueryErrorNotice error={error} hasData={hasData} />
        </div>
      ) : null}
      {pending ? (
        <ChartSkeleton />
      ) : hasData || !error ? (
        <PegDeviationChart
          data={data}
          pegCurrency="USD"
          embedded
        />
      ) : null}
      <figcaption className="border-t border-border/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-6">
        {widget.caption}
      </figcaption>
    </figure>
  );
}
