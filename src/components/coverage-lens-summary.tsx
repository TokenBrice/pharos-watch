"use client";

import { useMemo } from "react";
import { formatCurrency } from "@shared/lib/format";
import type { CoverageRow } from "@/lib/coverage";
import { FILTER_OPTIONS, type CoverageFilterKey } from "@/lib/coverage-page-config";

interface CoverageLensSummaryProps {
  rows: CoverageRow[];
  filteredRows: CoverageRow[];
  search: string;
  filter: CoverageFilterKey;
}

export function CoverageLensSummary({
  rows,
  filteredRows,
  search,
  filter,
}: CoverageLensSummaryProps) {
  const { filteredTrackedMcap, filteredMcapSharePct, lensSummary } = useMemo(() => {
    const totalTrackedMcap = rows.reduce((sum, row) => sum + row.marketCapUsd, 0);
    const filteredTrackedMcap = filteredRows.reduce((sum, row) => sum + row.marketCapUsd, 0);
    const filteredMcapSharePct = totalTrackedMcap > 0 ? (filteredTrackedMcap / totalTrackedMcap) * 100 : 0;
    const activeFilterLabel = FILTER_OPTIONS.find((option) => option.key === filter)?.label ?? "All";
    const trimmedSearch = search.trim();
    const lensSummary = trimmedSearch
      ? `Search lens: "${trimmedSearch}"`
      : filter !== "all"
        ? `Filter lens: ${activeFilterLabel}`
        : "Full tracked universe";

    return { filteredTrackedMcap, filteredMcapSharePct, lensSummary };
  }, [filter, filteredRows, rows, search]);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
      <div className="rounded-2xl border border-border/60 bg-background/40 px-4 py-3">
        <p className="pharos-kicker">Current Lens</p>
        <p className="mt-1 text-sm text-foreground">{lensSummary}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Use this matrix to separate broad market coverage from niche or still-bootstrapping surfaces before you click into a single coin.
        </p>
      </div>
      <div className="rounded-2xl border border-border/60 bg-background/40 px-4 py-3">
        <p className="pharos-kicker">Market Share In View</p>
        <p className="mt-1 text-sm text-foreground">{filteredMcapSharePct.toFixed(0)}% of tracked market cap</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatCurrency(filteredTrackedMcap)} in the current result set.
        </p>
      </div>
    </div>
  );
}
