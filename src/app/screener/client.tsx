"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { SelectorCallout } from "@/components/selector/selector-callout";
import { TableExportMenu } from "@/components/table-export-menu";
import { ScreenerToolbar } from "@/components/screener/screener-toolbar";
import { ScreenerTable } from "@/components/screener/screener-table";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { logosById } from "@/lib/logos";
import { usePegSummary, useReportCardsV9Table, useStressSignals, useDexLiquidityTable } from "@/hooks/api-hooks";
import { useSort } from "@/hooks/use-sort";
import { useHydrated } from "@/hooks/use-hydrated";
import { buildQueryFreshnessGroup } from "@/lib/query-refetch-group";
import { useUrlState } from "@/hooks/use-url-state";
import {
  SCREENER_FILTER_DEFAULTS,
  SCREENER_URL_SCHEMA,
  applyFilters,
  countActiveScreenerFilters,
  resolveScreenerFilterDataState,
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
import { getResolvedBlacklistStatusLabel } from "@shared/lib/blacklist-status";
import { isIncludedInArchetype } from "@shared/lib/stablecoins/mechanism-membership";
import { resolveCustodyModel } from "@shared/lib/report-card-policy";
import {
  resolveMintAuthorityScoreDisplay,
} from "@/lib/mint-authority-display";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";
import { MINT_AUTHORITY_SCORE_FILTER_CONFIG, MINT_AUTHORITY_STATUS_CONFIG } from "@shared/lib/classification";
import { buildV9SafetyTableMap } from "@/lib/safety-score-v9-consumers";
import { getCirculatingRawOrNull, getPrevMonthRawOrNull } from "@shared/lib/supply";
import type { CsvColumn } from "@/lib/exports/csv";
import { GOVERNANCE_LABELS, PEG_METADATA, getMechanismArchetypeLabel } from "@shared/lib/classification";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";
import { buildPegSummaryCoinMap } from "@/lib/stablecoin-lookups";
import type { TablePaginationProps } from "@/components/table-pagination";
import { describePartialEvidence, formatPartialEvidenceGap } from "@/lib/safety-score-reason-labels";

// Curated classification is immutable for the lifetime of the client bundle.
// Commodity pegs that only inherit a parent's archetype stay in the tracked
// universe; the membership predicate narrows mechanism deep-links to the
// mechanism pages' archetype buckets.
const SCREENABLE_COINS = CLIENT_TRACKED_STABLECOINS
  .filter((meta) => meta.status !== "quarantined" && meta.status !== "delisted")
  .map((meta) => {
    const mechanism = resolveMechanismArchetype(meta, CLIENT_ACTIVE_META_BY_ID);
    return {
      meta,
      mechanism,
      mechanismIncluded: isIncludedInArchetype(meta, mechanism),
      custodyModel: resolveCustodyModel(meta),
      blacklistable: projectBlacklistable(meta.blacklistStatus),
    };
  });

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
  { header: "supply_usd", accessor: (row) => row.supplyUsd ?? "" },
  { header: "peg_score", accessor: (row) => row.pegScore ?? "" },
  { header: "dews_score", accessor: (row) => row.dewsScore ?? "" },
  { header: "liquidity_score", accessor: (row) => row.liquidityScore ?? "" },
  { header: "safety_grade", accessor: (row) => row.safetyGrade ?? "" },
  { header: "safety_score", accessor: (row) => row.safetyScore ?? "" },
  { header: "safety_rating_status", accessor: (row) => row.ratingStatus ?? "" },
  { header: "safety_partial_evidence", accessor: (row) => describePartialEvidence(row)?.gaps.map(formatPartialEvidenceGap).join(" · ") ?? "" },
  // Export cause labels are a stable data contract, independent of reader-facing sentence copy.
  { header: "safety_gap_causes", accessor: (row) => row.partialEvidence?.causes.map(cause => cause === "A" ? "pipeline unavailable (A)" : "public data awaiting curation (B)").join("; ") ?? "" },
  { header: "safety_backing", accessor: (row) => row.safetyBackingScore ?? "" },
  { header: "safety_exit", accessor: (row) => row.safetyExitScore ?? "" },
  { header: "safety_control", accessor: (row) => row.safetyControlScore ?? "" },
  { header: "safety_evidence", accessor: (row) => row.safetyEvidence },
  { header: "safety_weakest_pillar", accessor: (row) => row.safetyWeakestPillar ?? "" },
  { header: "safety_binding_cap", accessor: (row) => row.safetyBindingCapReason ?? "" },
  { header: "custody_model", accessor: (row) => row.custodyModel },
  // The reviewed label keeps "Upstream" for inherited exposure; the filter
  // vocabulary stays the legacy three-bucket projection.
  { header: "blacklistable", accessor: (row) => getResolvedBlacklistStatusLabel(row.id) ?? "" },
  {
    header: "mint_authority",
    accessor: (row) => MINT_AUTHORITY_STATUS_CONFIG[row.mintAuthority].spokenLabel,
  },
  { header: "mint_authority_score", accessor: (row) => row.mintAuthorityScore ?? "" },
  {
    header: "mint_authority_score_band",
    accessor: (row) => row.mintAuthorityScoreBand === null
      ? null
      : MINT_AUTHORITY_SCORE_FILTER_CONFIG[row.mintAuthorityScoreBand].label,
  },
];

function buildSupplySeries(asset: StablecoinData | undefined): ReadonlyArray<number | null> | undefined {
  if (!asset) return undefined;
  const prevMonth = getPrevMonthRawOrNull(asset);
  // A missing current bucket stays a gap, never a fabricated zero endpoint.
  return prevMonth == null ? undefined : [prevMonth, getCirculatingRawOrNull(asset)];
}

// The two endpoints are the all-time worst tracked deviation and the current
// published deviation; this is a range, not a 30-day history window.
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
    isLoading: isPegLoading,
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
  } = useReportCardsV9Table();
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
  } = useDexLiquidityTable();

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

  // Source-local projections must not be rebuilt (or readmitted) whenever a
  // sibling query arrives.
  const pegById = useMemo(() => buildPegSummaryCoinMap(pegData?.coins), [pegData?.coins]);
  const safetyProjection = useMemo(
    () => reportData ? buildV9SafetyTableMap(reportData, reportData.safetyScoreIdentity) : null,
    [reportData],
  );
  const safetyById = useMemo(
    () => safetyProjection?.status === "available" ? safetyProjection.value : {},
    [safetyProjection],
  );
  // A missing/inadmissible report-cards publication is not the same claim as
  // an admitted card with no published mint posture (which stays "nr").
  const safetyPublicationAvailable = safetyProjection?.status === "available";

  // Build only after a primary dataset is available, including retained data.
  // Optional score reads preserve unknown values until their sources arrive.
  const allRows = useMemo<ScreenerRow[]>(() => {
    if (!stablecoinsData?.peggedAssets) return [];
    const supplyById = new Map<string, number | null>();
    const supplySeriesById = new Map<string, ReadonlyArray<number | null>>();
    const unobservedPriceIds = new Set<string>();
    for (const asset of stablecoinsData.peggedAssets) {
      if (!isObservedPrice(asset)) unobservedPriceIds.add(asset.id);
      supplyById.set(asset.id, getCirculatingRawOrNull(asset));
      const supplySeries = buildSupplySeries(asset);
      if (supplySeries) supplySeriesById.set(asset.id, supplySeries);
    }

    const rows: ScreenerRow[] = [];
    for (const { meta, mechanism, mechanismIncluded, custodyModel, blacklistable } of SCREENABLE_COINS) {
      const safety = safetyById[meta.id] ?? null;
      const pegCoin = pegById.get(meta.id);
      const mintAuthorityScore = safetyPublicationAvailable
        ? resolveMintAuthorityScoreDisplay(safety?.mint)
        : null;
      rows.push({
        id: meta.id,
        name: meta.name,
        symbol: meta.symbol,
        lifecycle: meta.status ?? "active",
        type: meta.flags.governance,
        mechanism,
        mechanismIncluded,
        peg: meta.flags.pegCurrency,
        supplyUsd: supplyById.get(meta.id) ?? null,
        pegScore: pegCoin?.pegScore ?? null,
        dewsScore: stressData?.signals[meta.id]?.score ?? null,
        liquidityScore: dexData?.[meta.id]?.liquidityScore ?? null,
        safetyGrade: safety?.grade ?? null,
        safetyScore: safety?.score ?? null,
        ratingStatus: safety?.ratingStatus ?? null,
        partialEvidence: safety?.partialEvidence ?? null,
        pillars: safety?.pillars,
        safetyBackingScore: safety?.pillars.backing.score ?? null,
        safetyExitScore: safety?.pillars.exit.score ?? null,
        safetyControlScore: safety?.pillars.control.score ?? null,
        safetyEvidence:
          safety?.ratingStatus === "pipeline-gap"
            ? "pipeline-gap"
            : safety?.ratingStatus === "not-rated"
              ? "nr"
              : safety?.evidence.level === "insufficient"
                ? "limited"
                : safety?.evidence.level ?? null,
        safetyWeakestPillar: safety?.weakestPillar?.pillar ?? null,
        safetyWeakestScore: safety?.weakestPillar?.score ?? null,
        safetyBindingCapReason: safety?.bindingCapReason ?? null,
        custodyModel,
        blacklistable,
        mintAuthority: meta.mintAuthorityStatus ?? "unknown",
        mintAuthorityScore: mintAuthorityScore?.score ?? null,
        mintAuthorityScoreBand: mintAuthorityScore?.bandKey ?? null,
        mintAuthorityScoreLabel: mintAuthorityScore?.scoreLabel ?? null,
        mintAuthorityScoreBandLabel: mintAuthorityScore?.bandLabel ?? null,
        mintAuthorityScoreBadgeClassName: mintAuthorityScore?.badgeClassName ?? null,
        mintAuthorityScoreDetail: mintAuthorityScore?.detail ?? null,
        pegDeviationSeries: unobservedPriceIds.has(meta.id) ? undefined : buildPegDeviationSeries(pegCoin),
        supplySeries: supplySeriesById.get(meta.id),
      });
    }
    return rows;
  }, [stablecoinsData, pegById, safetyById, safetyPublicationAvailable, stressData, dexData]);

  const scoreFilterDataState = resolveScreenerFilterDataState(filters, {
    dews: { loading: isStressLoading, hasData: stressData != null, error: stressError },
    report: { loading: isReportLoading, hasData: safetyProjection?.status === "available", error: reportError },
    peg: { loading: isPegLoading, hasData: pegData != null, error: pegError },
    liquidity: { loading: isDexLoading, hasData: dexData != null, error: dexError },
  });
  const filteredRows = useMemo(
    () => scoreFilterDataState === "ready" ? applyFilters(allRows, filters) : [],
    [allRows, filters, scoreFilterDataState],
  );
  const { sortKey, sortDirection, toggleSort, getAriaSortValue } = useSort<ScreenerSortKey>("safetyScore", "desc");
  const sortedRows = useMemo(
    () => sortScreenerRows(filteredRows, sortKey, sortDirection),
    [filteredRows, sortKey, sortDirection],
  );
  const hasStablecoinRows = stablecoinsData?.peggedAssets !== undefined;
  const dataState: NonNullable<TablePaginationProps["dataState"]> = !hasStablecoinRows
    ? (stablecoinsError || !isStablecoinsLoading ? "unavailable" : "loading")
    : scoreFilterDataState;
  const exportRows = dataState === "ready" ? sortedRows : [];

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
      hasData: pegData != null,
      meta: pegMeta,
      refetch: refetchPeg,
    },
    {
      preset: "reportCards",
      data: reportData?.cards,
      dataUpdatedAt: reportUpdatedAt,
      error: reportError,
      hasData: safetyProjection?.status === "available",
      meta: reportMeta,
      refetch: refetchReport,
    },
    {
      preset: "stressSignals",
      data: stressData?.signals,
      dataUpdatedAt: stressUpdatedAt,
      error: stressError,
      hasData: stressData != null,
      meta: stressMeta,
      refetch: refetchStress,
    },
    {
      preset: "dexLiquidity",
      data: dexData,
      dataUpdatedAt: dexUpdatedAt,
      error: dexError,
      hasData: dexData != null,
      meta: dexMeta,
      refetch: refetchDex,
    },
  ]);
  // Every live feed contributes exported columns, even when it is not needed
  // to evaluate the active predicates. Receipt times never date these values.
  const sourceGenerations: Record<string, string | null> = Object.fromEntries(
    Object.entries({
      stablecoins: stablecoinsMeta,
      "peg-summary": pegMeta,
      "report-cards": reportMeta,
      "stress-signals": stressMeta,
      "dex-liquidity": dexMeta,
    }).map(([source, meta]) => {
      const updatedAt = meta?.updatedAt;
      return [source, typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
        ? new Date(updatedAt * 1000).toISOString()
        : null];
    }),
  );
  const generations = Object.values(sourceGenerations);
  // Conservative mixed-source convention: oldest producer, only if all known.
  const exportAsOfISO = generations.reduce<string | null>(
    (oldest, generation) => oldest === null || generation === null
      ? null : generation < oldest ? generation : oldest,
    generations[0] ?? null,
  ) ?? "unknown";

  const totalTracked = SCREENABLE_COINS.length;
  const totalRows = hasStablecoinRows ? allRows.length : totalTracked;
  const matchingRows = filteredRows.length;
  const active = hasActiveFilters(filters);
  const activeFilterCount = countActiveScreenerFilters(filters);
  // One coin-count story: the screener universe is the full tracked registry
  // (visible pre-launch and frozen rows included), unlike the active-only dashboard table.
  // Policy-withheld quarantined and delisted records remain detail-only.
  // The live matched count is the toolbar's One Beam (frost) figure.

  return (
    <div className="space-y-6">
      {hasHydrated ? <SelectorCallout /> : (
        <div className="h-[50px] animate-pulse rounded-md bg-muted/30 sm:h-[136px] lg:h-[113px] xl:h-[89px]" aria-hidden="true" />
      )}

      <ScreenerToolbar
        filters={filters}
        matchingRows={matchingRows}
        totalRows={totalRows}
        dataState={dataState}
        activeFilterCount={activeFilterCount}
        onChange={setFilters}
        onReset={resetFilters}
        rightSlot={
          <TableExportMenu
            data={exportRows}
            columns={EXPORT_COLUMNS}
            filename="screener"
            asOfISO={exportAsOfISO}
            sourceGenerations={sourceGenerations}
            endpoint="screener"
            // 9.1: the mint columns are the published V9 mint component, so
            // they are stamped with the safety-score identity. The retired
            // standalone mint-authority lane no longer produces this value.
            methodologyLabel={safetyPublicationAvailable && reportData
              ? `safety-score ${toMethodologyVersionLabel(reportData.safetyScoreIdentity.methodologyVersion)} (mint control columns included); mixed-source export, as-of oldest producer generation when all known`
              : "safety-score columns unavailable this run; mixed-source export, as-of oldest producer generation when all known"}
            triggerLabel={dataState === "loading" ? "Loading" : "Export"}
            triggerClassName="min-w-24"
            disabled={dataState !== "ready"}
          />
        }
      />

      <section id="data" aria-label="Data table" tabIndex={-1} className="space-y-6">
        <QueryFreshnessNotices
          error={freshnessGroup.globalError}
          hasData={hasStablecoinRows}
          onRetry={freshnessGroup.refetchAll}
          queries={freshnessGroup.queries}
        />
        <ScreenerTable
          rows={sortedRows}
          logos={logos}
          dataState={dataState}
          onClearFilters={active ? resetFilters : undefined}
          hasActiveFilters={active}
          sort={{ sortKey, sortDirection, toggleSort, getAriaSortValue }}
        />
      </section>
    </div>
  );
}
