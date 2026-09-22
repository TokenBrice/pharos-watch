"use client";

import { useSupplyHistory } from "@/hooks/use-stablecoins";
import { PegDeviationChart } from "@/components/peg-deviation-chart";
import { QueryErrorNotice } from "@/components/query-error-notice";
import type {
  CaseStudyDataWidget,
  CaseStudyEventWindow,
} from "@/lib/case-studies/types";
import { getCaseStudyChartDays } from "@/lib/case-study-event-window";

/**
 * Live Pharos peg-deviation chart embedded in a case study. Hydrates
 * client-side via `useSupplyHistory` (fine under static export) and reuses the
 * coin's curated annotation overlay. Only rendered for data-rich coins where a
 * real series exists; historical pre-collection events omit `dataWidgets`.
 */
export function CaseStudyChart({
  widget,
  eventWindows,
}: {
  widget: CaseStudyDataWidget;
  eventWindows: readonly CaseStudyEventWindow[];
}) {
  const { data, error } = useSupplyHistory(
    widget.coinId,
    getCaseStudyChartDays(eventWindows),
  );

  return (
    <figure className="pharos-card-shell overflow-hidden">
      {error ? (
        <div className="px-4 py-4 sm:px-6">
          <QueryErrorNotice error={error} hasData={data.length > 0} />
        </div>
      ) : (
        <PegDeviationChart
          data={data}
          pegCurrency="USD"
          stablecoinId={widget.coinId}
          embedded
        />
      )}
      <figcaption className="border-t border-border/40 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground sm:px-6">
        {widget.caption}
      </figcaption>
    </figure>
  );
}
