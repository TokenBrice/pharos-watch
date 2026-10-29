"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { FilterSearchInput } from "@/components/filter-search-input";
import { ControlPillToggle } from "@/components/control-pill-toggle";
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
  type ComplianceViewModel,
} from "@/lib/compliance-model";
import { ComplianceTable } from "./compliance-table";
import { OverviewDirectory } from "./overview-directory";

interface ComplianceUrlState {
  regime: ComplianceRegimeFilter;
  status: ComplianceStatusFilter;
  type: MicaTokenType | "all";
  peg: PegCurrency | "all";
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
  peg: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: COMPLIANCE_PEG_VALUES,
  },
};

const COMPLIANCE_TAB_IDS: Record<ComplianceRegimeFilter, string> = {
  all: "compliance-tab-all",
  mica: "compliance-tab-mica",
  genius: "compliance-tab-genius",
};

const COMPLIANCE_PANEL_IDS: Record<ComplianceRegimeFilter, string> = {
  all: "compliance-overview-panel",
  mica: "compliance-mica-panel",
  genius: "compliance-genius-panel",
};

const COMPLIANCE_REGIME_HEADINGS: Record<"mica" | "genius", string> = {
  mica: "MiCA authorization",
  genius: "GENIUS Act status",
};

function ComplianceViewTabs({
  value,
  onChange,
}: {
  value: ComplianceRegimeFilter;
  onChange: (value: ComplianceRegimeFilter) => void;
}) {
  const tabRefs = useRef<Partial<Record<ComplianceRegimeFilter, HTMLButtonElement | null>>>({});

  return (
    <div role="tablist" aria-label="Compliance view" className="flex border-b border-border/60">
      {COMPLIANCE_REGIME_FILTER_OPTIONS.map((option, index) => {
        const isActive = option.value === value;
        const label = option.value === "all" ? "Overview" : option.label;
        return (
          <button
            key={option.value}
            ref={(node) => {
              tabRefs.current[option.value] = node;
            }}
            id={COMPLIANCE_TAB_IDS[option.value]}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={COMPLIANCE_PANEL_IDS[option.value]}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const lastIndex = COMPLIANCE_REGIME_FILTER_OPTIONS.length - 1;
              const nextIndex =
                event.key === "ArrowRight"
                  ? (index + 1) % COMPLIANCE_REGIME_FILTER_OPTIONS.length
                  : event.key === "ArrowLeft"
                    ? (index + COMPLIANCE_REGIME_FILTER_OPTIONS.length - 1) % COMPLIANCE_REGIME_FILTER_OPTIONS.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? lastIndex
                        : null;
              if (nextIndex === null) return;
              event.preventDefault();
              const next = COMPLIANCE_REGIME_FILTER_OPTIONS[nextIndex];
              onChange(next.value);
              tabRefs.current[next.value]?.focus();
            }}
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

function inferRegimeFromFilters({
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

function ComplianceRegimePanel({
  regime,
  model,
  logos,
  forceCollapsedBandsOpen,
}: {
  regime: "mica" | "genius";
  model: ComplianceViewModel;
  logos: Record<string, string> | undefined;
  forceCollapsedBandsOpen: boolean;
}) {
  const { rows, watchRows, isGeniusEffective } = model;
  const regimeLabel = regime === "mica" ? "MiCA" : "GENIUS";

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id={regime} className="pharos-label scroll-mt-24">
              <a
                href={`/compliance/?regime=${regime}#${regime}`}
                className="pharos-focus-ring rounded-sm hover:text-foreground"
              >
                {COMPLIANCE_REGIME_HEADINGS[regime]}
              </a>
            </h2>
            <p className="text-xs text-muted-foreground">
              Active, assessed stablecoins only. Frozen and pre-launch assets are excluded from the main table.
            </p>
          </div>
          <span className="pharos-numeric text-xs text-muted-foreground">
            {rows.length.toLocaleString()} rows
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="pharos-empty-note px-4 py-3 text-center text-sm text-muted-foreground">
            {regime === "genius" && !isGeniusEffective
              ? "GENIUS rows remain in implementation watch until the regime is effective."
              : "No stablecoins match these filters."}
          </div>
        ) : (
          <ComplianceTable
            rows={rows}
            regime={regime}
            logos={logos}
            tableId={`compliance-${regime}-authorization`}
            testId={`compliance-${regime}-authorization-table`}
            ariaLabel={`${regimeLabel} compliance authorization table`}
            forceCollapsedBandsOpen={forceCollapsedBandsOpen}
          />
        )}
      </div>

      {watchRows.length > 0 || regime === "genius" ? (
        <div id="implementation-watch" className="space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="pharos-label">GENIUS implementation watch</p>
              <p className="text-xs text-muted-foreground">
                Source-backed signals before the Act is generally effective, plus pre-launch assets even
                after effectiveness. These rows are not compliance determinations.
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
  );
}

export function ComplianceClient() {
  const logos = logosById;
  const { getParam, setParam, isReady: isUrlReady } = useUrlFilters();
  const { state: urlState, patchState: writeUrlState, searchParams } = useUrlState(COMPLIANCE_URL_SCHEMA);

  const rawRegime = searchParams.get("regime") ?? "";
  const rawStatus = urlState.status;
  const rawTokenType = urlState.type;
  const regimeFilter = inferRegimeFromFilters({ rawRegime, rawStatus, rawTokenType });
  const statusFilter = normalizeComplianceStatusFilter(rawStatus, regimeFilter);
  const tokenTypeFilter = regimeFilter === "genius" ? "all" : normalizeMicaTokenTypeFilter(rawTokenType);
  const pegFilter = urlState.peg;

  const setRegimeFilter = useCallback((v: ComplianceRegimeFilter) => {
    trackEvent("filter_applied", { page: "compliance", filter_type: "regime", filter_value: v });
    trackEvent("filter_applied", { page: "compliance", filter_type: "view", filter_value: v });
    writeUrlState({ regime: v, status: "all", type: "all" });
  }, [writeUrlState]);

  const setStatusFilter = useCallback((v: ComplianceStatusFilter) => {
    trackEvent("filter_applied", { page: "compliance", filter_type: "status", filter_value: v });
    writeUrlState({ status: v });
  }, [writeUrlState]);

  const setTokenTypeFilter = useCallback((v: MicaTokenType | "all") => {
    trackEvent("filter_applied", { page: "compliance", filter_type: "type", filter_value: v });
    writeUrlState({ type: v });
  }, [writeUrlState]);

  const setPegFilter = useCallback((v: PegCurrency | "all") => {
    trackEvent("filter_applied", { page: "compliance", filter_type: "peg", filter_value: v });
    writeUrlState({ peg: v });
  }, [writeUrlState]);

  const openOverviewStatus = useCallback((regime: "mica" | "genius", status: MicaStatus | GeniusAuthorizationStatus) => {
    trackEvent("filter_applied", { page: "compliance", filter_type: "view", filter_value: regime });
    trackEvent("filter_applied", { page: "compliance", filter_type: "status", filter_value: status });
    writeUrlState({ regime, status, type: "all" });
  }, [writeUrlState]);

  const { searchInput, setSearchInput, deferredSearch } = useUrlSearchSync(
    "compliance",
    { getParam, setParam },
  );

  // Each regime keeps its own model so every panel is mounted independently.
  // Status and MiCA token type only narrow the selected regime; the inactive
  // regime stays unfiltered and GENIUS never takes a token type.
  const mica = useMemo(
    () =>
      buildComplianceViewModel({
        regime: "mica",
        status: regimeFilter === "mica" ? statusFilter : "all",
        tokenType: regimeFilter === "mica" ? tokenTypeFilter : "all",
        peg: pegFilter,
        search: deferredSearch,
      }),
    [regimeFilter, statusFilter, tokenTypeFilter, pegFilter, deferredSearch],
  );
  const genius = useMemo(
    () =>
      buildComplianceViewModel({
        regime: "genius",
        status: regimeFilter === "genius" ? statusFilter : "all",
        tokenType: "all",
        peg: pegFilter,
        search: deferredSearch,
      }),
    [regimeFilter, statusFilter, pegFilter, deferredSearch],
  );
  const overview = useMemo(
    () => buildComplianceOverviewModel({ peg: pegFilter, search: deferredSearch }),
    [pegFilter, deferredSearch],
  );

  const activeModel = regimeFilter === "mica" ? mica : regimeFilter === "genius" ? genius : null;
  const statusOptions = regimeFilter === "genius" ? GENIUS_STATUS_FILTER_OPTIONS : MICA_STATUS_FILTER_OPTIONS;
  const matchingCount = activeModel ? activeModel.rows.length + activeModel.watchRows.length : overview.rows.length;
  const totalCount = activeModel ? activeModel.totalTracked : overview.totalCoins;
  // A shared search exposes matches in both panels; a regime status filter only
  // opens the selected regime's bands, so an inactive panel stays collapsed.
  const searchForcesBandsOpen = deferredSearch.trim().length > 0;
  const micaForceBandsOpen = searchForcesBandsOpen || (regimeFilter === "mica" && statusFilter !== "all");
  const geniusForceBandsOpen = searchForcesBandsOpen || (regimeFilter === "genius" && statusFilter !== "all");

  // A heading permalink only aligns an already-visible panel; the explicit
  // `regime` query stays the single regime-state authority.
  const handledPermalinkHash = useRef<string | null>(null);
  useEffect(() => {
    if (!isUrlReady) return;
    const hash = window.location.hash;
    const target = hash === "#mica" ? "mica" : hash === "#genius" ? "genius" : null;
    if (!target || regimeFilter !== target || handledPermalinkHash.current === hash) return;
    handledPermalinkHash.current = hash;
    document.getElementById(target)?.scrollIntoView?.({ block: "start" });
  }, [isUrlReady, regimeFilter]);

  return (
    <div className="space-y-6">
      <section id="data" aria-label="Compliance data" tabIndex={-1} className="space-y-5">
        <div className="pharos-table-toolbar overflow-hidden rounded-xl border border-border/60">
          <ComplianceViewTabs value={regimeFilter} onChange={setRegimeFilter} />
          <div className="flex flex-col gap-3 p-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="pharos-label">Compliance workbench</p>
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
                <ControlPillToggle
                  className="flex flex-wrap gap-1.5"
                  ariaLabel={`Filter by ${regimeFilter === "mica" ? "MiCA" : "GENIUS"} status`}
                  options={statusOptions}
                  value={statusFilter}
                  onChange={setStatusFilter}
                  buttonClassName="min-h-[44px] text-xs md:min-h-0"
                />
              ) : null}
              {regimeFilter === "mica" ? (
                <ControlPillToggle
                  className="flex flex-wrap gap-1.5"
                  ariaLabel="Filter by MiCA token type"
                  options={MICA_TOKEN_TYPE_FILTER_OPTIONS}
                  value={tokenTypeFilter}
                  onChange={setTokenTypeFilter}
                  buttonClassName="min-h-[44px] text-xs md:min-h-0"
                />
              ) : null}
              <ControlPillToggle
                className="flex flex-wrap gap-1.5"
                ariaLabel="Filter by peg currency"
                options={PEG_FILTER_OPTIONS}
                value={pegFilter}
                onChange={setPegFilter}
                buttonClassName="min-h-[44px] text-xs md:min-h-0"
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

        <div
          id={COMPLIANCE_PANEL_IDS.all}
          role="tabpanel"
          aria-labelledby={COMPLIANCE_TAB_IDS.all}
          tabIndex={0}
          hidden={regimeFilter !== "all"}
        >
          <OverviewDirectory
            rows={overview.rows}
            logos={logos}
            onStatusClick={openOverviewStatus}
            filterKey={`${pegFilter}:${searchInput}`}
          />
        </div>
        <div
          id={COMPLIANCE_PANEL_IDS.mica}
          role="tabpanel"
          aria-labelledby={COMPLIANCE_TAB_IDS.mica}
          tabIndex={0}
          hidden={regimeFilter !== "mica"}
        >
          <ComplianceRegimePanel
            regime="mica"
            model={mica}
            logos={logos}
            forceCollapsedBandsOpen={micaForceBandsOpen}
          />
        </div>
        <div
          id={COMPLIANCE_PANEL_IDS.genius}
          role="tabpanel"
          aria-labelledby={COMPLIANCE_TAB_IDS.genius}
          tabIndex={0}
          hidden={regimeFilter !== "genius"}
        >
          <ComplianceRegimePanel
            regime="genius"
            model={genius}
            logos={logos}
            forceCollapsedBandsOpen={geniusForceBandsOpen}
          />
        </div>
      </section>
    </div>
  );
}
