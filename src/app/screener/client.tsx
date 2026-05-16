"use client";

import { useCallback, useMemo } from "react";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { TableExportMenu } from "@/components/table-export-menu";
import { ScreenerToolbar } from "@/components/screener/screener-toolbar";
import { ScreenerTable } from "@/components/screener/screener-table";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { usePegSummary, useReportCards, useStressSignals, useDexLiquidity } from "@/hooks/api-hooks";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useSort } from "@/hooks/use-sort";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { decodeState, encodeState } from "@/lib/url-state";
import {
  SCREENER_FILTER_DEFAULTS,
  SCREENER_URL_SCHEMA,
  applyFilters,
  hasLoadingScoreFilterData,
  hasActiveFilters,
  projectBlacklistable,
  sortScreenerRows,
  type ScreenerFilters,
  type ScreenerRow,
  type ScreenerSortKey,
} from "@/app/screener/screener-filters";
import {
  CLIENT_TRACKED_META_BY_ID,
  CLIENT_TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/client-registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import { SAFETY_SCORE_VERSION_LABEL } from "@shared/lib/safety-score-version";
import type { CsvColumn } from "@/lib/exports/csv";
import { PEG_METADATA, getMechanismArchetypeLabel } from "@shared/lib/classification";

const EXPORT_COLUMNS: CsvColumn<ScreenerRow>[] = [
  { header: "id", accessor: (row) => row.id },
  { header: "symbol", accessor: (row) => row.symbol },
  { header: "name", accessor: (row) => row.name },
  { header: "lifecycle", accessor: (row) => row.lifecycle },
  {
    header: "mechanism",
    accessor: (row) => (row.mechanism ? getMechanismArchetypeLabel(row.mechanism) : ""),
  },
  { header: "peg", accessor: (row) => PEG_METADATA[row.peg]?.filterLabel ?? row.peg },
  { header: "supply_usd", accessor: (row) => row.supplyUsd },
  { header: "peg_score", accessor: (row) => row.pegScore ?? "" },
  { header: "dews_score", accessor: (row) => row.dewsScore ?? "" },
  { header: "liquidity_score", accessor: (row) => row.liquidityScore ?? "" },
  { header: "safety_grade", accessor: (row) => row.safetyGrade ?? "" },
  { header: "safety_score", accessor: (row) => row.safetyScore ?? "" },
  { header: "blacklistable", accessor: (row) => row.blacklistable ?? "" },
];

export function ScreenerClient() {
  const {
    data: stablecoinsData,
    isLoading: isStablecoinsLoading,
    dataUpdatedAt: stablecoinsUpdatedAt,
    error: stablecoinsError,
    refetch: refetchStablecoins,
    meta: stablecoinsMeta,
  } = useStablecoins();
  const {
    data: pegData,
    isLoading: isPegLoading,
    dataUpdatedAt: pegUpdatedAt,
    error: pegError,
    refetch: refetchPeg,
    meta: pegMeta,
  } = usePegSummary();
  const {
    data: reportData,
    dataUpdatedAt: reportUpdatedAt,
    error: reportError,
    refetch: refetchReport,
    meta: reportMeta,
  } = useReportCards();
  const {
    data: stressData,
    isLoading: isStressLoading,
    dataUpdatedAt: stressUpdatedAt,
    error: stressError,
    refetch: refetchStress,
    meta: stressMeta,
  } = useStressSignals();
  const {
    data: dexData,
    isLoading: isDexLoading,
    dataUpdatedAt: dexUpdatedAt,
    error: dexError,
    refetch: refetchDex,
    meta: dexMeta,
  } = useDexLiquidity();

  const { searchParams, replaceParams } = useUrlFilters();

  // Decode filters from URL via W1-F codec on every searchParams change.
  const filters = useMemo<ScreenerFilters>(
    () => decodeState(searchParams, SCREENER_URL_SCHEMA),
    [searchParams],
  );

  const setFilters = useCallback(
    (next: ScreenerFilters) => {
      const encoded = encodeState(next, SCREENER_URL_SCHEMA);
      replaceParams((params) => {
        // Clear only the screener-owned keys; leave any unrelated params alone.
        for (const key of Object.keys(SCREENER_URL_SCHEMA)) {
          params.delete(key);
        }
        const incoming = new URLSearchParams(encoded);
        for (const [key, value] of incoming) {
          params.set(key, value);
        }
      });
    },
    [replaceParams],
  );

  const resetFilters = useCallback(() => setFilters(SCREENER_FILTER_DEFAULTS), [setFilters]);

  // Build the merged row set. Gated on `useStablecoins().isSuccess` per the
  // brief's escalation note: filters applied to incomplete data would
  // momentarily hide coins whose scores haven't streamed in yet.
  const allRows = useMemo<ScreenerRow[]>(() => {
    if (!stablecoinsData?.peggedAssets) return [];
    const supplyById = new Map<string, number>();
    for (const asset of stablecoinsData.peggedAssets) {
      supplyById.set(asset.id, getCirculatingRaw(asset));
    }
    const pegById = new Map<string, number | null>();
    for (const coin of pegData?.coins ?? []) {
      pegById.set(coin.id, coin.pegScore);
    }
    const reportById = new Map<string, { grade: string; score: number | null }>();
    for (const card of reportData?.cards ?? []) {
      reportById.set(card.id, { grade: card.overallGrade, score: card.overallScore });
    }
    const dewsById = new Map<string, number>();
    for (const [id, entry] of Object.entries(stressData?.signals ?? {})) {
      dewsById.set(id, entry.score);
    }
    const liquidityById = new Map<string, number | null>();
    for (const [id, entry] of Object.entries(dexData ?? {})) {
      liquidityById.set(id, entry.liquidityScore);
    }

    const rows: ScreenerRow[] = [];
    for (const meta of CLIENT_TRACKED_STABLECOINS) {
      const lifecycle = meta.status ?? "active";
      const safety = reportById.get(meta.id) ?? null;
      rows.push({
        id: meta.id,
        name: meta.name,
        symbol: meta.symbol,
        lifecycle,
        mechanism: meta.mechanismArchetype ?? null,
        peg: meta.flags.pegCurrency,
        supplyUsd: supplyById.get(meta.id) ?? 0,
        pegScore: pegById.get(meta.id) ?? null,
        dewsScore: dewsById.get(meta.id) ?? null,
        liquidityScore: liquidityById.get(meta.id) ?? null,
        safetyGrade: safety?.grade ?? null,
        safetyScore: safety?.score ?? null,
        blacklistable: projectBlacklistable(meta.canBeBlacklisted),
      });
    }
    return rows;
  }, [stablecoinsData, pegData, reportData, stressData, dexData]);

  const filteredRows = useMemo(
    () => applyFilters(allRows, filters),
    [allRows, filters],
  );
  const scoreFilterDataLoading = hasLoadingScoreFilterData(filters, {
    pegLoading: isPegLoading,
    pegHasData: !!pegData?.coins?.length,
    dewsLoading: isStressLoading,
    dewsHasData: stressData ? Object.keys(stressData.signals).length > 0 : false,
    liquidityLoading: isDexLoading,
    liquidityHasData: dexData ? Object.keys(dexData).length > 0 : false,
  });
  const { sortKey, sortDirection, toggleSort, getAriaSortValue } = useSort<ScreenerSortKey>(
    "safetyScore",
    "desc",
  );
  const sortedRows = useMemo(
    () => sortScreenerRows(filteredRows, sortKey, sortDirection),
    [filteredRows, sortKey, sortDirection],
  );
  const toolbarResultCount = scoreFilterDataLoading ? allRows.length : filteredRows.length;
  const exportRows = scoreFilterDataLoading ? [] : sortedRows;

  const handleRetry = useCallback(
    () => refetchQueryGroup([refetchStablecoins, refetchPeg, refetchReport, refetchStress, refetchDex]),
    [refetchStablecoins, refetchPeg, refetchReport, refetchStress, refetchDex],
  );

  const totalTracked = CLIENT_TRACKED_META_BY_ID.size;
  const active = hasActiveFilters(filters);

  // Surfaces a banner if the underlying queries error out; mirrors other
  // multi-source surfaces.
  const globalError = stablecoinsError ?? pegError ?? reportError ?? stressError ?? dexError;

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={globalError}
        hasData={!!stablecoinsData?.peggedAssets?.length}
        onRetry={handleRetry}
        queries={[
          {
            preset: "stablecoins",
            dataUpdatedAt: stablecoinsUpdatedAt,
            error: stablecoinsError,
            hasData: !!stablecoinsData?.peggedAssets?.length,
            meta: stablecoinsMeta,
          },
          {
            preset: "pegSummary",
            dataUpdatedAt: pegUpdatedAt,
            error: pegError,
            hasData: !!pegData?.coins?.length,
            meta: pegMeta,
          },
          {
            preset: "reportCards",
            dataUpdatedAt: reportUpdatedAt,
            error: reportError,
            hasData: !!reportData?.cards?.length,
            meta: reportMeta,
          },
          {
            preset: "stressSignals",
            dataUpdatedAt: stressUpdatedAt,
            error: stressError,
            hasData: stressData ? Object.keys(stressData.signals).length > 0 : false,
            meta: stressMeta,
          },
          {
            preset: "dexLiquidity",
            dataUpdatedAt: dexUpdatedAt,
            error: dexError,
            hasData: dexData ? Object.keys(dexData).length > 0 : false,
            meta: dexMeta,
          },
        ]}
      />

      <ScreenerToolbar
        filters={filters}
        onChange={setFilters}
        onReset={resetFilters}
        resultCount={toolbarResultCount}
        totalCount={totalTracked}
        rightSlot={
          <TableExportMenu
            data={exportRows}
            columns={EXPORT_COLUMNS}
            filename="screener"
            endpoint="screener"
            methodologyLabel={`safety-score ${SAFETY_SCORE_VERSION_LABEL}`}
            triggerLabel={scoreFilterDataLoading ? "Loading" : "Export"}
            disabled={scoreFilterDataLoading}
          />
        }
      />

      <ScreenerTable
        rows={sortedRows}
        isLoading={isStablecoinsLoading || scoreFilterDataLoading}
        onClearFilters={active ? resetFilters : undefined}
        hasActiveFilters={active}
        sort={{ sortKey, sortDirection, toggleSort, getAriaSortValue }}
      />
    </div>
  );
}
