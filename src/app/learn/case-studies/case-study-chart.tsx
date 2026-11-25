"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { useSupplyHistory } from "@/hooks/use-stablecoins";
import { PegDeviationChart } from "@/components/chart-primitives/peg-deviation-chart";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import type {
  CaseStudyDataWidget,
  CaseStudyEventWindow,
} from "@shared/types/editorial-content";
import { getCaseStudyChartDays } from "@/lib/case-study-event-window";
import { formatCrisisWindowsLabel } from "./case-study-format";

/**
 * Live Pharos peg-deviation chart embedded in a case study. Hydrates
 * client-side via `useSupplyHistory` (fine under static export). Only rendered
 * for data-rich coins where a real series exists; historical pre-collection
 * events omit `dataWidgets`. Event annotation overlays are retired.
 */
export function CaseStudyChart({
  widget,
  eventWindows,
  coinSymbol,
  coinName,
  coinLogoSrc,
}: {
  widget: CaseStudyDataWidget;
  eventWindows: readonly CaseStudyEventWindow[];
  coinSymbol?: string;
  coinName?: string;
  coinLogoSrc?: string | null;
}) {
  const { data, error, isLoading } = useSupplyHistory(
    widget.coinId,
    getCaseStudyChartDays(eventWindows),
  );
  const hasData = data.some((point) => point.price != null && point.price > 0);
  const pending = isLoading && !hasData;
  const windowSummary = formatCrisisWindowsLabel(eventWindows);

  return (
    <figure className="pharos-card-shell overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/50 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          {coinLogoSrc ? (
            <img
              src={coinLogoSrc}
              alt=""
              aria-hidden="true"
              width={20}
              height={20}
              className="h-5 w-5 shrink-0 rounded-full"
              loading="lazy"
            />
          ) : null}
          <Link
            href={buildStablecoinUrl(widget.coinId)}
            className="pharos-focus-ring group inline-flex min-w-0 items-center gap-1.5 rounded-sm text-sm font-semibold text-foreground transition-colors hover:text-brand-accent-text"
          >
            <span className="pharos-numeric">{coinSymbol ?? widget.coinId}</span>
            {coinName ? (
              <span className="truncate font-normal text-muted-foreground transition-colors group-hover:text-foreground">
                {coinName}
              </span>
            ) : null}
            <ArrowUpRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-brand-accent-text"
              aria-hidden="true"
            />
          </Link>
        </div>
        {windowSummary ? (
          <p className="pharos-meta">
            Crisis window (UTC):{" "}
            <span className="pharos-numeric text-foreground/85">{windowSummary}</span>
          </p>
        ) : null}
      </div>
      <div className="p-3 sm:p-4">
        {error && !hasData ? (
          <QueryErrorNotice error={error} hasData={hasData} />
        ) : pending ? (
          <ChartSkeleton />
        ) : hasData || !error ? (
          <div className="pharos-chart-stage rounded-lg p-0">
            <PegDeviationChart
              data={data}
              pegCurrency="USD"
              embedded
            />
          </div>
        ) : null}
      </div>
      <figcaption className="border-t border-border/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-6">
        {widget.caption}
      </figcaption>
    </figure>
  );
}
