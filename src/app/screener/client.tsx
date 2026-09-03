"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { SafetyScoreV9StatusNotice } from "@/components/safety-score-v9-status-notice";
import { SelectorCallout } from "@/components/selector/selector-callout";
import { TableExportMenu } from "@/components/table-export-menu";
import { ScreenerToolbar } from "@/components/screener/screener-toolbar";
import { ScreenerTable } from "@/components/screener/screener-table";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { logosById } from "@/lib/logos";
import { usePegSummary, useReportCardsV9, useStressSignals, useDexLiquidity } from "@/hooks/api-hooks";
import { useSort } from "@/hooks/use-sort";
import { useHydrated } from "@/hooks/use-hydrated";
import { buildQueryFreshnessGroup } from "@/lib/query-refetch-group";
import { useUrlState } from "@/hooks/use-url-state";
import {
  SCREENER_FILTER_DEFAULTS,
  SCREENER_URL_SCHEMA,
  applyFilters,
  countActiveScreenerFilters,
  hasLoadingScoreFilterData,
  hasActiveFilters,
  normalizeScreenerDeepLinkAliases,
  projectBlacklistable,
  sortScreenerRows,
  type ScreenerRow,
  type ScreenerSortKey,
} from "@/lib/screener-filters";
import {
  CLIENT_ACTIVE_META_BY_ID,
  CLIENT_TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/client-registry";
import { resolveMechanismArchetype } from "@shared/lib/classification";
import { resolveCustodyModel } from "@shared/lib/report-card-policy";
import {
  MINT_AUTHORITY_SCORE_FILTER_CONFIG,
  MINT_AUTHORITY_STATUS_CONFIG,
  resolveMintAuthorityScoreDisplay,
} from "@/lib/mint-authority-display";
import { buildV9SafetyTableMap } from "@/lib/safety-score-v9-consumers";
import { getCirculatingRaw, getPrevMonthRawOrNull } from "@shared/lib/supply";
import type { CsvColumn } from "@/lib/exports/csv";
import { GOVERNANCE_LABELS, PEG_METADATA, getMechanismArchetypeLabel } from "@shared/lib/classification";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";

const EXPORT_COLUMNS: CsvColumn<ScreenerRow>[] = [
  { header: "id", accessor: (row) => row.id },
  { header: "symbol", accessor: (row) => row.symbol },
  { header: "name", accessor: (row) => row.name },
  { header: "lifecycle", accessor: (row) => row.lifecycle },
  { header: "type", accessor: (row) => GOVERNANCE_LABELS[row.type] ?? row.type },
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
  { header: "safety_backing", accessor: (row) => row.safetyBackingScore ?? "" },
  { header: "safety_exit", accessor: (row) => row.safetyExitScore ?? "" },
  { header: "safety_control", accessor: (row) => row.safetyControlScore ?? "" },
  { header: "safety_evidence", accessor: (row) => row.safetyEvidence },
  { header: "safety_weakest_pillar", accessor: (row) => row.safetyWeakestPillar ?? "" },
  { header: "safety_binding_cap", accessor: (row) => row.safetyBindingCapReason ?? "" },
  { header: "custody_model", accessor: (row) => row.custodyModel },
  { header: "blacklistable", accessor: (row) => row.blacklistable ?? "" },
  {
    header: "mint_authority",
    accessor: (row) => MINT_AUTHORITY_STATUS_CONFIG[row.mintAuthority].spokenLabel,
  },
  { header: "mint_authority_score", accessor: (row) => row.mintAuthorityScore ?? "" },
  {
    header: "mint_authority_score_band",
    accessor: (row) => MINT_AUTHORITY_SCORE_FILTER_CONFIG[row.mintAuthorityScoreBand].label,
  },
];

function buildSupplySeries(asset: StablecoinData | undefined): ReadonlyArray<number | null> | undefined {
  if (!asset) return undefined;
  const current = getCirculatingRaw(asset);
  const prevMonth = getPrevMonthRawOrNull(asset);
  return prevMonth == null ? undefined : [prevMonth, current];
}

function buildPegDeviationSeries(pegCoin: PegSummaryCoin | undefined): ReadonlyArray<number | null> | undefined {
  if (pegCoin?.currentDeviationBps == null) return undefined;
  return [pegCoin.worstDeviationBps ?? pegCoin.currentDeviationBps, pegCoin.currentDeviationBps];
}

export function ScreenerClient() {
  const hasHydrated = useHydrated();
  const logos = logosById;
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
    dataUpdatedAt: pegUpdatedAt,
    error: pegError,
    refetch: refetchPeg,
    meta: pegMeta,
  } = usePegSummary();
  const {
    data: reportData,
    isLoading: isReportLoading,
    dataUpdatedAt: reportUpdatedAt,
    error: reportError,
    refetch: refetchReport,
    meta: reportMeta,
  } = useReportCardsV9();
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
    dataUpdatedAt: dexUpdatedAt,
    error: dexError,
    refetch: refetchDex,
    meta: dexMeta,
  } = useDexLiquidity();

  const { state: filters, replaceState: setFilters } = useUrlState(SCREENER_URL_SCHEMA, {
    enabled: hasHydrated,
    fallback: SCREENER_FILTER_DEFAULTS,
  });

  // Normalize legacy singular deep-link aliases (e.g. `/screener/?mechanism=cdp`)
  // into the canonical plural URL schema, once after hydration. Pins
  // `lifecycle=active` when arriving via a mechanism
  // deep-link without an explicit lifecycle so deep-linked views don't
  // accidentally include pre-launch or frozen coins.
  const aliasNormalizedRef = useRef(false);
  useEffect(() => {
    if (!hasHydrated || aliasNormalizedRef.current) return;
    aliasNormalizedRef.current = true;
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    if (!normalizeScreenerDeepLinkAliases(params)) return;

    const qs = params.toString();
    const nextSearch = qs ? `?${qs}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${nextSearch}${window.location.hash}`);
  }, [hasHydrated]);

  const resetFilters = useCallback(() => setFilters(SCREENER_FILTER_DEFAULTS), [setFilters]);

  // Build the merged row set. Gated on `useStablecoins().isSuccess` per the
  // brief's escalation note: filters applied to incomplete data would
  // momentarily hide coins whose scores haven't streamed in yet.
  const allRows = useMemo<ScreenerRow[]>(() => {
    if (!stablecoinsData?.peggedAssets) return [];
    const supplyById = new Map<string, number>();
    const supplySeriesById = new Map<string, ReadonlyArray<number | null>>();
    for (const asset of stablecoinsData.peggedAssets) {
      supplyById.set(asset.id, getCirculatingRaw(asset));
      const supplySeries = buildSupplySeries(asset);
      if (supplySeries) supplySeriesById.set(asset.id, supplySeries);
    }
    const pegById = new Map<string, PegSummaryCoin>();
    for (const coin of pegData?.coins ?? []) {
      pegById.set(coin.id, coin);
    }
    const projectedSafety = reportData
      ? buildV9SafetyTableMap(reportData, reportData.safetyScoreIdentity)
      : null;
    const safetyById = projectedSafety?.status === "available" ? projectedSafety.value : {};
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
      if (meta.status === "quarantined" || meta.status === "delisted") continue;
      const lifecycle = meta.status ?? "active";
      const safety = safetyById[meta.id] ?? null;
      const pegCoin = pegById.get(meta.id);
      const mintAuthorityScore = resolveMintAuthorityScoreDisplay(safety?.mint);
      rows.push({
        id: meta.id,
        name: meta.name,
        symbol: meta.symbol,
        lifecycle,
        type: meta.flags.governance,
        mechanism: resolveMechanismArchetype(meta, CLIENT_ACTIVE_META_BY_ID),
        peg: meta.flags.pegCurrency,
        supplyUsd: supplyById.get(meta.id) ?? 0,
        pegScore: pegCoin?.pegScore ?? null,
        dewsScore: dewsById.get(meta.id) ?? null,
        liquidityScore: liquidityById.get(meta.id) ?? null,
        safetyGrade: safety?.grade ?? null,
        safetyScore: safety?.score ?? null,
        safetyBackingScore: safety?.pillars.backing.score ?? null,
        safetyExitScore: safety?.pillars.exit.score ?? null,
        safetyControlScore: safety?.pillars.control.score ?? null,
        safetyEvidence:
          safety?.grade === "NR"
            ? "nr"
            : safety?.evidence.level === "insufficient"
              ? "limited"
              : safety?.evidence.level ?? "nr",
        safetyWeakestPillar: safety?.weakestPillar?.pillar ?? null,
        safetyWeakestScore: safety?.weakestPillar?.score ?? null,
        safetyBindingCapReason: safety?.bindingCapReason ?? null,
        custodyModel: resolveCustodyModel(meta),
        blacklistable: projectBlacklistable(meta.blacklistStatus),
        mintAuthority: meta.mintAuthorityStatus ?? "unknown",
        mintAuthorityScore: mintAuthorityScore.score,
        mintAuthorityScoreBand: mintAuthorityScore.bandKey,
        mintAuthorityScoreLabel: mintAuthorityScore.scoreLabel,
        mintAuthorityScoreBandLabel: mintAuthorityScore.bandLabel,
        mintAuthorityScoreBadgeClassName: mintAuthorityScore.badgeClassName,
        mintAuthorityScoreDetail: mintAuthorityScore.detail,
        pegDeviationSeries: buildPegDeviationSeries(pegCoin),
        supplySeries: supplySeriesById.get(meta.id),
      });
    }
    return rows;
  }, [stablecoinsData, pegData, reportData, stressData, dexData]);

  const filteredRows = useMemo(() => applyFilters(allRows, filters), [allRows, filters]);
  const scoreFilterDataLoading = hasLoadingScoreFilterData(filters, {
    dewsLoading: isStressLoading,
    dewsHasData: stressData ? Object.keys(stressData.signals).length > 0 : false,
    reportLoading: isReportLoading,
    reportHasData: !!reportData?.cards?.length,
  });
  const { sortKey, sortDirection, toggleSort, getAriaSortValue } = useSort<ScreenerSortKey>("safetyScore", "desc");
  const sortedRows = useMemo(
    () => sortScreenerRows(filteredRows, sortKey, sortDirection),
    [filteredRows, sortKey, sortDirection],
  );
  const exportRows = scoreFilterDataLoading ? [] : sortedRows;

  const hasStablecoinRows = !!stablecoinsData?.peggedAssets?.length;

  const freshnessGroup = buildQueryFreshnessGroup([
    {
      preset: "stablecoins",
      data: stablecoinsData?.peggedAssets,
      dataUpdatedAt: stablecoinsUpdatedAt,
      error: stablecoinsError,
      hasData: hasStablecoinRows,
      meta: stablecoinsMeta,
      refetch: refetchStablecoins,
    },
    {
      preset: "pegSummary",
      data: pegData?.coins,
      dataUpdatedAt: pegUpdatedAt,
      error: pegError,
      hasData: !!pegData?.coins?.length,
      meta: pegMeta,
      refetch: refetchPeg,
    },
    {
      preset: "reportCards",
      data: reportData?.cards,
      dataUpdatedAt: reportUpdatedAt,
      error: reportError,
      hasData: !!reportData?.cards?.length,
      meta: reportMeta,
      refetch: refetchReport,
    },
    {
      preset: "stressSignals",
      data: stressData?.signals,
      dataUpdatedAt: stressUpdatedAt,
      error: stressError,
      hasData: stressData ? Object.keys(stressData.signals).length > 0 : false,
      meta: stressMeta,
      refetch: refetchStress,
    },
    {
      preset: "dexLiquidity",
      data: dexData,
      dataUpdatedAt: dexUpdatedAt,
      error: dexError,
      hasData: dexData ? Object.keys(dexData).length > 0 : false,
      meta: dexMeta,
      refetch: refetchDex,
    },
  ]);

  const totalTracked = CLIENT_TRACKED_STABLECOINS.filter(
    (coin) => coin.status !== "quarantined" && coin.status !== "delisted",
  ).length;
  const totalRows = allRows.length || totalTracked;
  const matchingRows = scoreFilterDataLoading ? totalRows : filteredRows.length;
  const active = hasActiveFilters(filters);
  const activeFilterCount = countActiveScreenerFilters(filters);
  // One coin-count story: the screener universe is the full tracked registry
  // (visible pre-launch and frozen rows included), unlike the active-only dashboard table.
  // Policy-withheld quarantined and delisted records remain detail-only.
  // The live matched count is the toolbar's One Beam (frost) figure.

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={freshnessGroup.globalError}
        hasData={hasStablecoinRows}
        onRetry={freshnessGroup.refetchAll}
        queries={freshnessGroup.queries}
      />
      <SafetyScoreV9StatusNotice response={reportData} />

      <SelectorCallout />

      <ScreenerToolbar
        filters={filters}
        matchingRows={matchingRows}
        totalRows={totalRows}
        activeFilterCount={activeFilterCount}
        onChange={setFilters}
        onReset={resetFilters}
        rightSlot={
          <TableExportMenu
            data={exportRows}
            columns={EXPORT_COLUMNS}
            filename="screener"
            endpoint="screener"
            // 9.1: the mint columns are the published V9 mint component, so
            // they are stamped with the safety-score identity. The retired
            // standalone mint-authority lane no longer produces this value.
            methodologyLabel={`safety-score ${reportData?.safetyScoreIdentity?.methodologyVersion ?? "v9"} (mint control columns included)`}
            triggerLabel={scoreFilterDataLoading ? "Loading" : "Export"}
            disabled={scoreFilterDataLoading}
          />
        }
      />

      <section id="data" aria-label="Data table" tabIndex={-1}>
        <ScreenerTable
          rows={sortedRows}
          logos={logos}
          isLoading={isStablecoinsLoading || scoreFilterDataLoading}
          onClearFilters={active ? resetFilters : undefined}
          hasActiveFilters={active}
          sort={{ sortKey, sortDirection, toggleSort, getAriaSortValue }}
        />
      </section>
    </div>
  );
}
