"use client";

import { useCallback, useMemo } from "react";
import { FilterSearchInput } from "@/components/filter-search-input";
import { logosById } from "@/lib/logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useUrlSearchSync } from "@/hooks/use-url-search-sync";
import { trackEvent } from "@/lib/analytics";
import { type UrlStateSchema } from "@/lib/url-state";
import { useUrlState } from "@/hooks/use-url-state";
import { cn } from "@/lib/utils";
import { PEG_FILTER_OPTIONS, PEG_METADATA } from "@shared/lib/classification";
import type {
  GeniusAuthorizationStatus,
  MicaStatus,
  MicaTokenType,
  PegCurrency,
} from "@shared/types";
import {
  COMPLIANCE_REGIME_FILTER_OPTIONS,
  COMPLIANCE_REGIME_VALUES,
  GENIUS_STATUS_FILTER_OPTIONS,
  MICA_STATUS_FILTER_OPTIONS,
  MICA_TOKEN_TYPE_FILTER_OPTIONS,
  buildComplianceOverviewModel,
  buildComplianceViewModel,
  isGeniusAuthorizationStatus,
  isMicaStatus,
  normalizeComplianceRegimeFilter,
  normalizeComplianceStatusFilter,
  normalizeMicaTokenTypeFilter,
  type ComplianceRegimeFilter,
  type ComplianceStatusFilter,
} from "@/lib/compliance-model";
import { ComplianceTable } from "./compliance-table";
import { OverviewDirectory } from "./overview-directory";

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

const COMPLIANCE_URL_SCHEMA: UrlStateSchema<ComplianceUrlState> = {
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
  const logos = logosById;
  const { getParam, setParam } = useUrlFilters();
  const { state: urlState, patchState: writeUrlState, searchParams } = useUrlState(COMPLIANCE_URL_SCHEMA);

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

  const setRegimeFilter = useCallback((v: ComplianceRegimeFilter) => {
    trackEvent("filter_applied", { page: "compliance", filter_type: "regime", filter_value: v });
    trackEvent("filter_applied", { page: "compliance", filter_type: "view", filter_value: v });
    writeUrlState({ regime: v, status: "all", type: "all", tokenType: "all" });
  }, [writeUrlState]);

  const setStatusFilter = useCallback((v: ComplianceStatusFilter) => {
    trackEvent("filter_applied", { page: "compliance", filter_type: "status", filter_value: v });
    writeUrlState({ status: v });
  }, [writeUrlState]);

  const setTokenTypeFilter = useCallback((v: MicaTokenType | "all") => {
    trackEvent("filter_applied", { page: "compliance", filter_type: "type", filter_value: v });
    writeUrlState({ type: v, tokenType: "all" });
  }, [writeUrlState]);

  const setPegFilter = useCallback((v: PegCurrency | "all") => {
    trackEvent("filter_applied", { page: "compliance", filter_type: "peg", filter_value: v });
    writeUrlState({ peg: v, pegCurrency: "all" });
  }, [writeUrlState]);

  const openOverviewStatus = useCallback((regime: "mica" | "genius", status: MicaStatus | GeniusAuthorizationStatus) => {
    trackEvent("filter_applied", { page: "compliance", filter_type: "view", filter_value: regime });
    trackEvent("filter_applied", { page: "compliance", filter_type: "status", filter_value: status });
    writeUrlState({ regime, status, type: "all", tokenType: "all" });
  }, [writeUrlState]);

  const { searchInput, setSearchInput, deferredSearch } = useUrlSearchSync(
    "compliance",
    { getParam, setParam },
  );

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
