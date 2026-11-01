"use client";

import { useMemo } from "react";
import { formatCurrency } from "@shared/lib/format";
import { summarizeCoverageMarketCap, type CoverageRow } from "@/lib/coverage";
import { FILTER_OPTIONS, type CoverageFilterKey } from "@/lib/coverage-page-config";

interface CoverageLensSummaryProps {
  rows: CoverageRow[];
  filteredRows: CoverageRow[];
  search: string;
  filter: CoverageFilterKey;
}

export function CoverageLensSummary({ rows, filteredRows, search, filter }: CoverageLensSummaryProps) {
  const { filteredCap, totalCap, filteredMcapShareLabel, lensSummary } = useMemo(() => {
    const totalCap = summarizeCoverageMarketCap(rows);
    const filteredCap = summarizeCoverageMarketCap(filteredRows);
    const filteredMcapSharePct = totalCap.totalUsd != null && totalCap.totalUsd > 0 &&
      (filteredCap.totalUsd != null || filteredRows.length === 0)
      ? ((filteredCap.totalUsd ?? 0) / totalCap.totalUsd) * 100
      : null;
    // A nonzero share never rounds to 0%, and a partial universe never reads 100%.
    const filteredMcapShareLabel = filteredMcapSharePct == null
      ? "n/a"
      : filteredMcapSharePct > 0 && filteredMcapSharePct < 1
        ? "<1%"
        : filteredMcapSharePct > 99 && filteredMcapSharePct < 100
          ? ">99%"
          : `${Math.round(filteredMcapSharePct)}%`;
    const activeFilterLabel = FILTER_OPTIONS.find((option) => option.key === filter)?.label ?? "All";
    const trimmedSearch = search.trim();
    const lensSummary = trimmedSearch
      ? `Search lens: "${trimmedSearch}"`
      : filter !== "all"
        ? `Filter lens: ${activeFilterLabel}`
        : "Full active universe";

    return { filteredCap, totalCap, filteredMcapShareLabel, lensSummary };
  }, [filter, filteredRows, rows, search]);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
      <div className="pharos-inset px-4 py-3">
        <p className="pharos-label">Current lens</p>
        <p className="mt-1 text-sm text-foreground">{lensSummary}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Use this matrix to separate broad market coverage from niche or still-bootstrapping surfaces before you click
          into a single coin.
        </p>
      </div>
      <div className="pharos-inset px-4 py-3">
        <p className="pharos-label">Market share in view</p>
        <p className="mt-1 text-sm text-foreground">
          <span className="pharos-numeric">{filteredMcapShareLabel}</span>{" "}
          of {totalCap.complete ? "active" : "known"} market cap
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {filteredCap.totalUsd == null ? "n/a" : formatCurrency(filteredCap.totalUsd)}{filteredCap.complete ? "" : " known market cap"} in the current result set.
        </p>
      </div>
    </div>
  );
}
