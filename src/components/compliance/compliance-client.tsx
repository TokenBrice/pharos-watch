"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown } from "lucide-react";
import { FilterSearchInput } from "@/components/filter-search-input";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  TableFrame,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { TableSourceLink } from "@/components/table/client";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useUrlSearchSync } from "@/hooks/use-url-search-sync";
import { trackEvent } from "@/lib/analytics";
import { decodeState, encodeState, type UrlStateSchema } from "@/lib/url-state";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { cn } from "@/lib/utils";
import { PEG_FILTER_OPTIONS, PEG_METADATA } from "@shared/lib/classification";
import {
  GENIUS_APPLICABILITY_LABELS,
  GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES,
  GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS,
  GENIUS_DASP_OFFER_SALE_STATUS_LABELS,
  GENIUS_ENFORCEMENT_STATUS_LABELS,
  GENIUS_FOREIGN_EXCEPTION_STATUS_LABELS,
  GENIUS_ISSUER_PATHWAY_LABELS,
} from "@shared/lib/genius";
import {
  MICA_AUTHORIZATION_TYPE_LABELS,
  MICA_STATUS_BADGE_STYLES,
  MICA_STATUS_DESCRIPTIONS,
  MICA_TOKEN_TYPE_BADGE_STYLES,
  MICA_TOKEN_TYPE_LABELS,
  MICA_SIGNIFICANT_BADGE_CLS,
} from "@shared/lib/mica";
import type {
  GeniusAuthorizationStatus,
  MicaStatus,
  MicaTokenType,
  PegCurrency,
} from "@shared/types";
import {
  COMPLIANCE_REGIME_FILTER_OPTIONS,
  COMPLIANCE_REGIME_VALUES,
  GENIUS_STATUS_DISPLAY_ORDER,
  GENIUS_STATUS_FILTER_OPTIONS,
  MICA_STATUS_DISPLAY_ORDER,
  MICA_STATUS_FILTER_OPTIONS,
  MICA_TOKEN_TYPE_FILTER_OPTIONS,
  buildComplianceOverviewModel,
  buildComplianceViewModel,
  groupComplianceRowsIntoBands,
  isGeniusAuthorizationStatus,
  isMicaStatus,
  normalizeComplianceRegimeFilter,
  normalizeComplianceStatusFilter,
  normalizeMicaTokenTypeFilter,
  type ComplianceOverviewRow,
  type ComplianceRegimeFilter,
  type ComplianceRow,
  type ComplianceStatusFilter,
} from "@/lib/compliance-model";

const COMPLIANCE_TEXT_CELL_CLASS = "whitespace-normal break-words align-top leading-snug";

interface ComplianceUrlState {
  regime: ComplianceRegimeFilter;
  status: ComplianceStatusFilter;
  type: MicaTokenType | "all";
  tokenType: MicaTokenType | "all";
  peg: PegCurrency | "all";
  pegCurrency: PegCurrency | "all";
}

const COMPLIANCE_STATUS_VALUES: readonly ComplianceStatusFilter[] = [
  "all",
  ...MICA_STATUS_FILTER_OPTIONS.map((option) => option.value),
  ...GENIUS_STATUS_FILTER_OPTIONS.map((option) => option.value),
];
const COMPLIANCE_TOKEN_TYPE_VALUES: readonly (MicaTokenType | "all")[] = MICA_TOKEN_TYPE_FILTER_OPTIONS.map(
  (option) => option.value,
);
const COMPLIANCE_PEG_VALUES: readonly (PegCurrency | "all")[] = [
  "all",
  ...(Object.keys(PEG_METADATA) as PegCurrency[]),
];

export const COMPLIANCE_URL_SCHEMA: UrlStateSchema<ComplianceUrlState> = {
  regime: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: COMPLIANCE_REGIME_VALUES,
  },
  status: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: COMPLIANCE_STATUS_VALUES,
  },
  type: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: COMPLIANCE_TOKEN_TYPE_VALUES,
  },
  tokenType: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: COMPLIANCE_TOKEN_TYPE_VALUES,
  },
  peg: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: COMPLIANCE_PEG_VALUES,
  },
  pegCurrency: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: COMPLIANCE_PEG_VALUES,
  },
};

function CompliancePillGroup<T extends string>({
  value,
  options,
  ariaLabel,
  className = "flex flex-wrap gap-1.5",
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  ariaLabel: string;
  className?: string;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={className}>
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(option.value)}
            className={cn(
              "pharos-focus-ring pharos-control-pill min-h-[44px] text-xs md:min-h-0",
              isActive && "pharos-control-pill-active",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function ComplianceViewTabs({
  value,
  onChange,
}: {
  value: ComplianceRegimeFilter;
  onChange: (value: ComplianceRegimeFilter) => void;
}) {
  return (
    <div role="tablist" aria-label="Compliance view" className="flex border-b border-border/60">
      {COMPLIANCE_REGIME_FILTER_OPTIONS.map((option) => {
        const isActive = option.value === value;
        const label = option.value === "all" ? "Overview" : option.label;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls="compliance-view-panel"
            onClick={() => onChange(option.value)}
            className={cn(
              "pharos-focus-ring min-h-11 border-b-2 px-4 text-sm font-medium transition-colors",
              isActive
                ? "border-frost-blue text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function inferRegimeFromLegacyParams({
  rawRegime,
  rawStatus,
  rawTokenType,
}: {
  rawRegime: string;
  rawStatus: string;
  rawTokenType: string;
}): ComplianceRegimeFilter {
  const normalizedRegime = normalizeComplianceRegimeFilter(rawRegime);
  if (rawRegime) return normalizedRegime;
  if (isMicaStatus(rawStatus) || normalizeMicaTokenTypeFilter(rawTokenType) !== "all") return "mica";
  if (isGeniusAuthorizationStatus(rawStatus)) return "genius";
  return normalizedRegime;
}

export function ComplianceClient() {
  const { data: logos } = useLogos();
  const { searchParams, replaceParams } = useUrlFilters();
  const urlState = useMemo(
    () => decodeState(searchParams, COMPLIANCE_URL_SCHEMA),
    [searchParams],
  );

  const rawRegime = searchParams.get("regime") ?? "";
  const rawStatus = urlState.status;
  // Legacy alias `tokenType` is read as a fallback for the canonical `type`
  // param to keep old `/compliance` deep links working. Deprecated since the
  // regime split; remove once analytics show no `tokenType=` traffic for a
  // full release window (canonical writers below only ever emit `type`).
  const rawTokenType = searchParams.has("type") ? urlState.type : urlState.tokenType;
  const regimeFilter = inferRegimeFromLegacyParams({ rawRegime, rawStatus, rawTokenType });
  const statusFilter = normalizeComplianceStatusFilter(rawStatus, regimeFilter);
  const tokenTypeFilter = regimeFilter === "genius" ? "all" : normalizeMicaTokenTypeFilter(rawTokenType);
  // Legacy alias `pegCurrency` -> canonical `peg`; same deprecation/removal plan
  // as `tokenType` above.
  const rawPeg = searchParams.has("peg") ? urlState.peg : urlState.pegCurrency;
  const pegFilter = rawPeg;

  const writeUrlState = useCallback(
    (updates: Partial<ComplianceUrlState>) => {
      const nextState = { ...urlState, ...updates };
      const encoded = encodeState(nextState, COMPLIANCE_URL_SCHEMA);
      replaceParams((params) => {
        for (const key of Object.keys(COMPLIANCE_URL_SCHEMA)) params.delete(key);
        for (const [key, value] of new URLSearchParams(encoded)) params.set(key, value);
      });
    },
    [replaceParams, urlState],
  );

  const setRegimeFilter = useCallback(
    (v: ComplianceRegimeFilter) => {
      trackEvent("filter_applied", { page: "compliance", filter_type: "regime", filter_value: v });
      trackEvent("filter_applied", { page: "compliance", filter_type: "view", filter_value: v });
      writeUrlState({ regime: v, status: "all", type: "all", tokenType: "all" });
    },
    [writeUrlState],
  );

  const setStatusFilter = useCallback(
    (v: ComplianceStatusFilter) => {
      trackEvent("filter_applied", { page: "compliance", filter_type: "status", filter_value: v });
      writeUrlState({ status: v });
    },
    [writeUrlState],
  );

  const setTokenTypeFilter = useCallback(
    (v: MicaTokenType | "all") => {
      trackEvent("filter_applied", { page: "compliance", filter_type: "type", filter_value: v });
      writeUrlState({ type: v, tokenType: "all" });
    },
    [writeUrlState],
  );

  const setPegFilter = useCallback(
    (v: PegCurrency | "all") => {
      trackEvent("filter_applied", { page: "compliance", filter_type: "peg", filter_value: v });
      writeUrlState({ peg: v, pegCurrency: "all" });
    },
    [writeUrlState],
  );

  const openOverviewStatus = useCallback(
    (regime: "mica" | "genius", status: MicaStatus | GeniusAuthorizationStatus) => {
      trackEvent("filter_applied", { page: "compliance", filter_type: "view", filter_value: regime });
      trackEvent("filter_applied", { page: "compliance", filter_type: "status", filter_value: status });
      writeUrlState({ regime, status, type: "all", tokenType: "all" });
    },
    [writeUrlState],
  );

  const { searchInput, setSearchInput, deferredSearch } = useUrlSearchSync("compliance");

  const { rows, watchRows, totalTracked, isGeniusEffective } = useMemo(
    () =>
      buildComplianceViewModel({
        regime: regimeFilter,
        status: statusFilter,
        tokenType: tokenTypeFilter,
        peg: pegFilter,
        search: deferredSearch,
      }),
    [regimeFilter, statusFilter, tokenTypeFilter, pegFilter, deferredSearch],
  );
  const overview = useMemo(
    () => buildComplianceOverviewModel({ peg: pegFilter, search: deferredSearch }),
    [pegFilter, deferredSearch],
  );

  const statusOptions = regimeFilter === "genius" ? GENIUS_STATUS_FILTER_OPTIONS : MICA_STATUS_FILTER_OPTIONS;
  const matchingCount = regimeFilter === "all" ? overview.rows.length : rows.length + watchRows.length;
  const totalCount = regimeFilter === "all" ? overview.totalCoins : totalTracked;
  const forceCollapsedBandsOpen = statusFilter !== "all" || deferredSearch.trim().length > 0;

  return (
    <div className="space-y-6">
      <section id="data" aria-label="Compliance data" tabIndex={-1} className="space-y-5">
        <div className="pharos-table-toolbar overflow-hidden rounded-xl border border-border/60">
          <ComplianceViewTabs value={regimeFilter} onChange={setRegimeFilter} />
          <div className="flex flex-col gap-3 p-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="pharos-kicker">Compliance Workbench</p>
              <p className="pharos-meta">
                {matchingCount === totalCount ? (
                  <>
                    <span className="pharos-numeric">{totalCount.toLocaleString()}</span>{" "}
                    {regimeFilter === "all" ? "stablecoins" : "assessed regime rows"}
                  </>
                ) : (
                  <>
                    <span className="pharos-numeric">{matchingCount.toLocaleString()}</span>/
                    <span className="pharos-numeric">{totalCount.toLocaleString()}</span> matching
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
              {regimeFilter !== "all" ? (
                <CompliancePillGroup
                  value={statusFilter}
                  options={statusOptions}
                  ariaLabel={`Filter by ${regimeFilter === "mica" ? "MiCA" : "GENIUS"} status`}
                  onChange={setStatusFilter}
                />
              ) : null}
              {regimeFilter === "mica" ? (
                <CompliancePillGroup
                  value={tokenTypeFilter}
                  options={MICA_TOKEN_TYPE_FILTER_OPTIONS}
                  ariaLabel="Filter by MiCA token type"
                  onChange={setTokenTypeFilter}
                />
              ) : null}
              <CompliancePillGroup
                value={pegFilter}
                options={PEG_FILTER_OPTIONS}
                ariaLabel="Filter by peg currency"
                onChange={setPegFilter}
              />
              <FilterSearchInput
                value={searchInput}
                onValueChange={setSearchInput}
                placeholder="Search..."
                className="relative w-full sm:w-44"
                inputClassName="pl-8 h-11 md:h-8 text-xs"
                ariaLabel="Search stablecoins by name or symbol"
              />
            </div>
          </div>
        </div>

        <div id="compliance-view-panel" role="tabpanel">
          {regimeFilter === "all" ? (
            <OverviewDirectory rows={overview.rows} logos={logos} onStatusClick={openOverviewStatus} />
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <p className="pharos-kicker">Authorization Table</p>
                    <p className="text-xs text-muted-foreground">
                      Active, assessed stablecoins only. Frozen and pre-launch assets are excluded from the main table.
                    </p>
                  </div>
                  <span className="pharos-numeric text-xs text-muted-foreground">
                    {rows.length.toLocaleString()} rows
                  </span>
                </div>
                {rows.length === 0 ? (
                  <div className="pharos-empty-note px-4 py-10 text-center text-sm text-muted-foreground">
                    {regimeFilter === "genius" && !isGeniusEffective
                      ? "GENIUS rows remain in implementation watch until the regime is effective."
                      : "No stablecoins match these filters."}
                  </div>
                ) : (
                  <ComplianceTable
                    rows={rows}
                    regime={regimeFilter}
                    logos={logos}
                    tableId="compliance-authorization"
                    testId="compliance-authorization-table"
                    ariaLabel="Compliance authorization table"
                    forceCollapsedBandsOpen={forceCollapsedBandsOpen}
                  />
                )}
              </div>

              {watchRows.length > 0 || regimeFilter === "genius" ? (
                <div id="implementation-watch" className="space-y-2">
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <p className="pharos-kicker">GENIUS Implementation Watch</p>
                      <p className="text-xs text-muted-foreground">
                        Source-backed signals before the Act is generally effective; these rows are not compliance
                        determinations.
                      </p>
                    </div>
                    <span className="pharos-numeric text-xs text-muted-foreground">
                      {watchRows.length.toLocaleString()} rows
                    </span>
                  </div>
                  {watchRows.length === 0 ? (
                    <div className="pharos-empty-note px-4 py-10 text-center text-sm text-muted-foreground">
                      No GENIUS implementation-watch rows match these filters.
                    </div>
                  ) : (
                    <ComplianceTable
                      rows={watchRows}
                      regime="genius"
                      logos={logos}
                      tableId="compliance-genius-watch"
                      testId="compliance-genius-watch-table"
                      ariaLabel="GENIUS implementation watch table"
                      forceCollapsedBandsOpen={forceCollapsedBandsOpen}
                    />
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

type OverviewSortColumn = "mica" | "genius";
interface OverviewSort {
  column: OverviewSortColumn;
  direction: "asc" | "desc";
}

function OverviewSortHeaderButton({
  column,
  label,
  sort,
  onToggle,
}: {
  column: OverviewSortColumn;
  label: string;
  sort: OverviewSort | null;
  onToggle: (column: OverviewSortColumn) => void;
}) {
  const isActive = sort?.column === column;
  return (
    <button
      type="button"
      onClick={() => onToggle(column)}
      aria-label={`Sort by ${label} status`}
      className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm hover:text-foreground"
    >
      {label}
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "h-3 w-3 transition-transform",
          !isActive && "opacity-40",
          isActive && sort?.direction === "desc" && "rotate-180",
        )}
      />
    </button>
  );
}

function OverviewDirectory({
  rows,
  logos,
  onStatusClick,
}: {
  rows: ComplianceOverviewRow[];
  logos: Record<string, string> | undefined;
  onStatusClick: (regime: "mica" | "genius", status: MicaStatus | GeniusAuthorizationStatus) => void;
}) {
  const [sort, setSort] = useState<OverviewSort | null>(null);

  const toggleSort = useCallback((column: OverviewSortColumn) => {
    setSort((previous) => {
      const next: OverviewSort | null =
        previous?.column !== column
          ? { column, direction: "asc" }
          : previous.direction === "asc"
            ? { column, direction: "desc" }
            : null;
      trackEvent("filter_applied", {
        page: "compliance",
        filter_type: "overview_sort",
        filter_value: next ? `${next.column}:${next.direction}` : "default",
      });
      return next;
    });
  }, []);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const order: readonly string[] = sort.column === "mica" ? MICA_STATUS_DISPLAY_ORDER : GENIUS_STATUS_DISPLAY_ORDER;
    const statusOf = (row: ComplianceOverviewRow) =>
      sort.column === "mica" ? row.mica?.status : row.genius?.status;
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const statusA = statusOf(a);
      const statusB = statusOf(b);
      // Unassessed rows stay last in either direction.
      if (!statusA || !statusB) {
        if (statusA) return -1;
        if (statusB) return 1;
        return a.symbol.localeCompare(b.symbol);
      }
      const delta = (order.indexOf(statusA) - order.indexOf(statusB)) * direction;
      if (delta !== 0) return delta;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [rows, sort]);

  const ariaSortFor = (column: OverviewSortColumn): "ascending" | "descending" | "none" =>
    sort?.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : "none";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="pharos-kicker">Stablecoin Directory</p>
          <p className="text-xs text-muted-foreground">One row per tracked coin with its assessed regime statuses.</p>
        </div>
        <span className="pharos-numeric text-xs text-muted-foreground">{rows.length.toLocaleString()} coins</span>
      </div>
      {rows.length === 0 ? (
        <div className="pharos-empty-note px-4 py-10 text-center text-sm text-muted-foreground">
          No stablecoins match these filters.
        </div>
      ) : (
        <TableFrame
          tableId="compliance-overview"
          testId="compliance-overview-table"
          chrome="bare"
          className="pharos-table-shell"
          tableClassName="table-fixed"
          tableProps={{ "aria-label": "Compliance overview directory" }}
          viewportClassName="relative w-full"
          viewportProps={{
            compactBottomPadding: false,
            horizontal: false,
            mobileScrollHint: false,
            overscrollX: false,
            scrollShadow: false,
          }}
        >
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[38%] px-1.5 sm:px-3">Coin</TableHead>
              <TableHead className="w-[14%] px-1.5 sm:px-3">Peg</TableHead>
              <TableHead className="w-[24%] px-1.5 text-center sm:px-3" aria-sort={ariaSortFor("mica")}>
                <OverviewSortHeaderButton column="mica" label="MiCA" sort={sort} onToggle={toggleSort} />
              </TableHead>
              <TableHead className="w-[24%] px-1.5 text-center sm:px-3" aria-sort={ariaSortFor("genius")}>
                <OverviewSortHeaderButton column="genius" label="GENIUS" sort={sort} onToggle={toggleSort} />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="px-1.5 sm:px-3">
                  <CoinLink row={row} logo={logos?.[row.id]} />
                </TableCell>
                <TableCell className="px-1.5 text-xs text-muted-foreground sm:px-3">
                  {PEG_METADATA[row.peg]?.filterLabel ?? row.peg}
                </TableCell>
                <TableCell className="px-1.5 text-center sm:px-3">
                  {row.mica ? (
                    <OverviewStatusButton
                      regime="mica"
                      status={row.mica.status}
                      coinSymbol={row.symbol}
                      onClick={onStatusClick}
                    />
                  ) : (
                    <EmptyCell />
                  )}
                </TableCell>
                <TableCell className="px-1.5 text-center sm:px-3">
                  {row.genius ? (
                    <OverviewStatusButton
                      regime="genius"
                      status={row.genius.status}
                      coinSymbol={row.symbol}
                      inWatch={row.genius.inWatch}
                      onClick={onStatusClick}
                    />
                  ) : (
                    <EmptyCell />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableFrame>
      )}
    </div>
  );
}

function OverviewStatusButton({
  regime,
  status,
  coinSymbol,
  inWatch = false,
  onClick,
}: {
  regime: "mica" | "genius";
  status: MicaStatus | GeniusAuthorizationStatus;
  coinSymbol: string;
  inWatch?: boolean;
  onClick: (regime: "mica" | "genius", status: MicaStatus | GeniusAuthorizationStatus) => void;
}) {
  const badge = regime === "mica"
    ? MICA_STATUS_BADGE_STYLES[status as MicaStatus]
    : GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[status as GeniusAuthorizationStatus];
  const description = regime === "mica"
    ? MICA_STATUS_DESCRIPTIONS[status as MicaStatus]
    : GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS[status as GeniusAuthorizationStatus];

  return (
    <button
      type="button"
      title={inWatch ? `${description} Implementation Watch.` : description}
      aria-label={`Show ${regime === "mica" ? "MiCA" : "GENIUS"} ${badge.label} stablecoins; selected from ${coinSymbol}`}
      onClick={() => onClick(regime, status)}
      className={cn(
        "pharos-focus-ring inline-flex max-w-full items-center justify-center whitespace-normal rounded-full border px-1.5 py-1 text-center text-[10px] font-semibold leading-tight sm:px-3 sm:text-xs",
        badge.cls,
      )}
    >
      {badge.label}
    </button>
  );
}

function ComplianceTable({
  rows,
  regime,
  logos,
  tableId,
  testId,
  ariaLabel,
  forceCollapsedBandsOpen,
}: {
  rows: ComplianceRow[];
  regime: "mica" | "genius";
  logos: Record<string, string> | undefined;
  tableId: string;
  testId: string;
  ariaLabel: string;
  forceCollapsedBandsOpen: boolean;
}) {
  const bands = groupComplianceRowsIntoBands(rows, regime);
  const [expandedBands, setExpandedBands] = useState<Record<string, boolean>>({});

  return (
    <TableFrame
      tableId={tableId}
      testId={testId}
      chrome="bare"
      className="pharos-table-shell"
      tableClassName="table-fixed min-w-[860px]"
      tableProps={{ "aria-label": ariaLabel }}
      viewportClassName="relative w-full"
      viewportProps={{ compactBottomPadding: false }}
    >
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[180px]">Coin</TableHead>
          <TableHead className="w-[140px]">Status</TableHead>
          <TableHead className="w-[165px]">Pathway / Type</TableHead>
          <TableHead className="w-[150px]">Authority</TableHead>
          <TableHead>Issuer Entity</TableHead>
          <TableHead className="w-12"><span className="sr-only">Details</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bands.map((band) => {
          const canCollapse = band.collapsedByDefault && !forceCollapsedBandsOpen;
          const isExpanded = canCollapse ? (expandedBands[band.status] ?? false) : true;
          return (
            <ComplianceBand
              key={band.status}
              band={band}
              logos={logos}
              tableId={tableId}
              canCollapse={canCollapse}
              isExpanded={isExpanded}
              onToggle={() => {
                setExpandedBands((current) => ({ ...current, [band.status]: !isExpanded }));
              }}
            />
          );
        })}
      </TableBody>
    </TableFrame>
  );
}

function ComplianceBand({
  band,
  logos,
  tableId,
  canCollapse,
  isExpanded,
  onToggle,
}: {
  band: ReturnType<typeof groupComplianceRowsIntoBands>[number];
  logos: Record<string, string> | undefined;
  tableId: string;
  canCollapse: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const countLabel = `${band.rows.length.toLocaleString()} ${band.rows.length === 1 ? "stablecoin" : "stablecoins"}`;

  return (
    <>
      <TableRow rowIntent="static" className="bg-muted/25 hover:bg-muted/25">
        <TableCell colSpan={6} className="p-0">
          {canCollapse ? (
            <button
              type="button"
              aria-expanded={isExpanded}
              onClick={onToggle}
              className="pharos-focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-left text-sm font-medium text-foreground"
            >
              <span>
                {band.label} <span className="font-normal text-muted-foreground">— {countLabel}, {isExpanded ? "collapse" : "expand"}</span>
              </span>
              <ChevronDown
                className={cn("h-4 w-4 shrink-0 transition-transform", isExpanded && "rotate-180")}
                aria-hidden="true"
              />
            </button>
          ) : (
            <div className="flex min-h-11 items-center gap-2 px-3 py-2">
              <ComplianceStatusBadge regime={band.rows[0].regime} status={band.status} />
              <span className="pharos-numeric text-xs text-muted-foreground">{countLabel}</span>
            </div>
          )}
        </TableCell>
      </TableRow>
      {isExpanded
        ? band.rows.map((row) => (
            <ComplianceTableRow key={`${row.regime}:${row.id}`} row={row} logo={logos?.[row.id]} tableId={tableId} />
          ))
        : null}
    </>
  );
}

function ComplianceTableRow({
  row,
  logo,
  tableId,
}: {
  row: ComplianceRow;
  logo: string | undefined;
  tableId: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasExtraDetail = hasComplianceRowDetails(row);
  const detailId = `${tableId}-${row.regime}-${row.id}-details`;

  return (
    <>
      <TableRow>
        <TableCell>
          <CoinLink row={row} logo={logo} />
        </TableCell>
        <TableCell>{row.regime === "mica" ? <MicaStatusCell row={row} /> : <GeniusStatusCell row={row} />}</TableCell>
        <TableCell className={COMPLIANCE_TEXT_CELL_CLASS}>
          {row.regime === "mica" ? <MicaPathwayCell row={row} /> : <GeniusPathwayCell row={row} />}
        </TableCell>
        <TableCell className={COMPLIANCE_TEXT_CELL_CLASS}>
          {row.regime === "mica" ? <MicaAuthorityCell row={row} /> : <GeniusAuthorityCell row={row} />}
        </TableCell>
        <TableCell className={COMPLIANCE_TEXT_CELL_CLASS}>
          {row.regime === "mica" ? (
            row.authorizedEntity ? <span className="text-sm">{row.authorizedEntity}</span> : <EmptyCell />
          ) : row.issuerEntity ? (
            <span className="text-sm">
              {row.issuerEntity}
              {row.issuerDomicile ? <span className="block text-xs text-muted-foreground">{row.issuerDomicile}</span> : null}
            </span>
          ) : (
            <EmptyCell />
          )}
        </TableCell>
        <TableCell className="px-1 text-right">
          {hasExtraDetail ? (
            <button
              type="button"
              aria-expanded={isExpanded}
              aria-controls={detailId}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} details for ${row.symbol}`}
              onClick={() => setIsExpanded((open) => !open)}
              className="pharos-focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground md:min-h-8 md:min-w-8"
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", isExpanded && "rotate-180")}
                aria-hidden="true"
              />
            </button>
          ) : null}
        </TableCell>
      </TableRow>
      {hasExtraDetail && isExpanded ? (
        <TableRow id={detailId} rowIntent="static" className="bg-muted/15 hover:bg-muted/15">
          <TableCell colSpan={6} className="whitespace-normal px-4 py-4">
            <ComplianceRowDetails row={row} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function CoinLink({
  row,
  logo,
}: {
  row: Pick<ComplianceOverviewRow, "id" | "name" | "symbol">;
  logo: string | undefined;
}) {
  return (
    <Link
      href={buildStablecoinUrl(row.id)}
      className="pharos-focus-ring inline-flex min-w-0 max-w-full items-center gap-2 rounded-sm hover:text-foreground"
    >
      <StablecoinLogo src={logo} name={row.name} size={28} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{row.symbol}</span>
        <span className="block truncate text-xs text-muted-foreground">{row.name}</span>
      </span>
    </Link>
  );
}

function ComplianceStatusBadge({
  regime,
  status,
}: {
  regime: "mica" | "genius";
  status: MicaStatus | GeniusAuthorizationStatus;
}) {
  const badge = regime === "mica"
    ? MICA_STATUS_BADGE_STYLES[status as MicaStatus]
    : GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[status as GeniusAuthorizationStatus];
  const description = regime === "mica"
    ? MICA_STATUS_DESCRIPTIONS[status as MicaStatus]
    : GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS[status as GeniusAuthorizationStatus];
  return (
    <span
      title={description}
      className={cn("inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold", badge.cls)}
    >
      {badge.label}
    </span>
  );
}

function MicaStatusCell({ row }: { row: Extract<ComplianceRow, { regime: "mica" }> }) {
  return <ComplianceStatusBadge regime="mica" status={row.status} />;
}

function GeniusStatusCell({ row }: { row: Extract<ComplianceRow, { regime: "genius" }> }) {
  return (
    <div className="space-y-1">
      <ComplianceStatusBadge regime="genius" status={row.status} />
      {row.enforcementStatus ? (
        <span className="block text-xs text-muted-foreground">
          Enforcement: {GENIUS_ENFORCEMENT_STATUS_LABELS[row.enforcementStatus]}
        </span>
      ) : null}
      {row.daspOfferSaleStatus ? (
        <span className="block text-xs text-muted-foreground">
          DASP: {GENIUS_DASP_OFFER_SALE_STATUS_LABELS[row.daspOfferSaleStatus]}
        </span>
      ) : null}
    </div>
  );
}

function MicaPathwayCell({ row }: { row: Extract<ComplianceRow, { regime: "mica" }> }) {
  const tokenType = row.tokenType ? MICA_TOKEN_TYPE_BADGE_STYLES[row.tokenType] : null;
  return (
    <div className="space-y-1">
      {tokenType ? (
        <span
          title={MICA_TOKEN_TYPE_LABELS[row.tokenType!]}
          className={cn(
            "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold",
            tokenType.cls,
          )}
        >
          {tokenType.label}
        </span>
      ) : (
        <EmptyCell />
      )}
      {row.authorizationType ? (
        <span className="block text-xs text-muted-foreground">
          {MICA_AUTHORIZATION_TYPE_LABELS[row.authorizationType]}
        </span>
      ) : null}
      {row.significant ? (
        <span
          title="EBA-supervised significant EMT/ART"
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold",
            MICA_SIGNIFICANT_BADGE_CLS,
          )}
        >
          <Check className="h-3 w-3" aria-hidden="true" />
          Significant
        </span>
      ) : null}
    </div>
  );
}

function GeniusPathwayCell({ row }: { row: Extract<ComplianceRow, { regime: "genius" }> }) {
  return (
    <span className="text-sm">
      {GENIUS_ISSUER_PATHWAY_LABELS[row.issuerPathway]}
      <span className="block text-xs text-muted-foreground">{GENIUS_APPLICABILITY_LABELS[row.applicability]}</span>
      {row.foreignExceptionStatus ? (
        <span className="block text-xs text-muted-foreground">
          Foreign exception: {GENIUS_FOREIGN_EXCEPTION_STATUS_LABELS[row.foreignExceptionStatus]}
        </span>
      ) : null}
    </span>
  );
}

function MicaAuthorityCell({ row }: { row: Extract<ComplianceRow, { regime: "mica" }> }) {
  return row.competentAuthority ? <span className="text-sm">{row.competentAuthority}</span> : <EmptyCell />;
}

function GeniusAuthorityCell({ row }: { row: Extract<ComplianceRow, { regime: "genius" }> }) {
  const authority = row.primaryFederalRegulator ?? row.stateRegulator ?? row.licensingRegulator;
  const secondaryAuthority = row.licensingRegulator && row.licensingRegulator !== authority
    ? row.licensingRegulator
    : row.stateRegulator && row.stateRegulator !== authority
      ? row.stateRegulator
      : undefined;

  return authority ? (
    <span className="text-sm">
      {authority}
      {secondaryAuthority ? <span className="block text-xs text-muted-foreground">{secondaryAuthority}</span> : null}
    </span>
  ) : (
    <EmptyCell />
  );
}

function hasGeniusReviewDetails(row: Extract<ComplianceRow, { regime: "genius" }>): boolean {
  return Boolean(
    row.notes ||
      row.applicabilitySummary ||
      row.foreignExceptionSummary ||
      row.negativeEvidenceSummary ||
      row.negativeEvidenceSourcesChecked.length > 0 ||
      row.reviewer ||
      row.reviewedAt,
  );
}

function hasComplianceRowDetails(row: ComplianceRow): boolean {
  if (row.references.length > 0) return true;
  return row.regime === "genius" && (row.hasAnyDisclosure || hasGeniusReviewDetails(row));
}

function ComplianceRowDetails({ row }: { row: ComplianceRow }) {
  const hasReviewDetails = row.regime === "genius" && hasGeniusReviewDetails(row);
  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {row.references.length > 0 ? (
        <div className="min-w-0 space-y-2">
          <p className="pharos-kicker">Sources</p>
          <SourceLinks references={row.references} />
        </div>
      ) : null}
      {hasReviewDetails ? <GeniusReviewDetails row={row} /> : null}
      {row.regime === "genius" && row.hasAnyDisclosure ? (
        <div className="min-w-0 space-y-2">
          <p className="pharos-kicker">Reserve Disclosure</p>
          <GeniusReserveCell row={row} />
        </div>
      ) : null}
    </div>
  );
}

function GeniusReserveCell({ row }: { row: Extract<ComplianceRow, { regime: "genius" }> }) {
  if (!row.hasAnyDisclosure) return <EmptyCell />;
  const content = (
    <>
      {row.reserveDisclosurePresent ? "Reserve disclosure" : "Disclosure"}
      {row.latestReportDate ? <span className="block text-xs text-muted-foreground">{row.latestReportDate}</span> : null}
      {row.redemptionPolicyPresent ? <span className="block text-xs text-muted-foreground">Redemption policy</span> : null}
      {row.monthlyAttestationPresent ? (
        <span className="block text-xs text-muted-foreground">Monthly attestation</span>
      ) : null}
    </>
  );
  if (!row.reserveDisclosureUrl) return <span className="text-sm">{content}</span>;
  return (
    <a
      href={row.reserveDisclosureUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="pharos-focus-ring inline-flex flex-col rounded-sm text-sm text-frost-blue hover:underline"
    >
      {content}
    </a>
  );
}

function GeniusReviewDetails({ row }: { row: Extract<ComplianceRow, { regime: "genius" }> }) {
  if (!hasGeniusReviewDetails(row)) return null;

  return (
    <div className="min-w-0 space-y-2 text-xs text-muted-foreground">
      <p className="pharos-kicker">Review Details</p>
      {row.reviewedAt || row.reviewer ? (
        <p>
          Reviewed{row.reviewedAt ? ` ${row.reviewedAt}` : ""}
          {row.reviewer ? ` by ${row.reviewer}` : ""}
        </p>
      ) : null}
      {row.applicabilitySummary ? <p>{row.applicabilitySummary}</p> : null}
      {row.foreignExceptionSummary ? <p>{row.foreignExceptionSummary}</p> : null}
      {row.negativeEvidenceSummary ? <p>{row.negativeEvidenceSummary}</p> : null}
      {row.notes ? <p>{row.notes}</p> : null}
      {row.negativeEvidenceSourcesChecked.length > 0 ? (
        <div className="space-y-1">
          <p className="font-medium text-foreground">Sources checked</p>
          <ul className="list-inside list-disc space-y-0.5">
            {row.negativeEvidenceSourcesChecked.slice(0, 5).map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SourceLinks({ references }: { references: readonly { label: string; url: string }[] }) {
  if (references.length === 0) return <EmptyCell />;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 overflow-hidden">
      {references.map((reference) => (
        <TableSourceLink
          key={`${reference.label}:${reference.url}`}
          href={reference.url}
          title={reference.label}
          className="pharos-focus-ring inline-flex max-w-full items-center gap-1 rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          iconClassName="h-3 w-3"
        >
          {reference.label}
        </TableSourceLink>
      ))}
    </div>
  );
}

function EmptyCell() {
  return <span className="text-xs text-muted-foreground">-</span>;
}
