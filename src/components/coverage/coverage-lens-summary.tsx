"use client";

import { useMemo } from "react";
import { formatCurrency } from "@shared/lib/format";
import { summarizeCoverageMarketCap, type CoverageRow } from "@/lib/coverage";
import {
  COVERAGE_MATRIX_FILTER_OPTIONS,
  type CoverageMatrixFilterKey,
} from "@/components/coverage/coverage-matrix-controls";

interface CoverageLensSummaryProps {
  rows: CoverageRow[];
  filteredRows: CoverageRow[];
  search: string;
  filter: CoverageMatrixFilterKey;
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
    const activeFilterLabel =
      COVERAGE_MATRIX_FILTER_OPTIONS.find((option) => option.key === filter)?.label ?? "All";
    const trimmedSearch = search.trim();
    const lensSummary = trimmedSearch
      ? `Search lens: "${trimmedSearch}"`
      : filter !== "all"
        ? `Filter lens: ${activeFilterLabel}`
        : "Full active universe";

    return { filteredCap, totalCap, filteredMcapShareLabel, lensSummary };
  }, [filter, filteredRows, rows, search]);

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{lensSummary}</span>
      <span aria-hidden="true" className="text-border">·</span>
      <span>
        <span className="pharos-numeric font-medium text-foreground">{filteredMcapShareLabel}</span>{" "}
        of {totalCap.complete ? "active" : "known"} market cap
      </span>
      <span aria-hidden="true" className="text-border">·</span>
      <span>
        <span className="pharos-numeric font-medium text-foreground">
          {filteredCap.totalUsd == null ? "n/a" : formatCurrency(filteredCap.totalUsd)}
        </span>
        {filteredCap.totalUsd != null && !filteredCap.complete ? " known market cap" : ""} in the current result set
      </span>
    </div>
  );
}
