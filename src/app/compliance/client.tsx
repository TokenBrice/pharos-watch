"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ExternalLink } from "lucide-react";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { trackEvent, trackSearch } from "@/lib/analytics";
import { buildStablecoinUrl } from "@/lib/urls";
import { GENIUS_REGIME_STATE } from "@shared/lib/compliance-regime-state";
import { PEG_FILTER_OPTIONS, PEG_METADATA } from "@shared/lib/classification";
import {
  GENIUS_APPLICABILITY_LABELS,
  GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES,
  GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS,
  GENIUS_ISSUER_PATHWAY_LABELS,
} from "@shared/lib/genius";
import {
  MICA_AUTHORIZATION_TYPE_LABELS,
  MICA_STATUS_BADGE_STYLES,
  MICA_STATUS_DESCRIPTIONS,
  MICA_TOKEN_TYPE_BADGE_STYLES,
  MICA_TOKEN_TYPE_LABELS,
} from "@shared/lib/mica";
import type { MicaTokenType, PegCurrency } from "@shared/types";
import {
  COMPLIANCE_REGIME_FILTER_OPTIONS,
  GENIUS_STATUS_FILTER_OPTIONS,
  MICA_STATUS_FILTER_OPTIONS,
  MICA_TOKEN_TYPE_FILTER_OPTIONS,
  buildComplianceViewModel,
  isGeniusAuthorizationStatus,
  isMicaStatus,
  normalizeComplianceRegimeFilter,
  normalizeComplianceStatusFilter,
  normalizeMicaTokenTypeFilter,
  type ComplianceRegimeFilter,
  type ComplianceRow,
  type ComplianceStatusFilter,
} from "./model";

function normalizePegFilter(value: string): PegCurrency | "all" {
  return value === "all" || value in PEG_METADATA ? (value as PegCurrency | "all") : "all";
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
  const { getParam, setParam, setParams } = useUrlFilters();

  const rawRegime = getParam("regime", "");
  const rawStatus = getParam("status", "all");
  const rawTokenType = getParam("type", getParam("tokenType", "all"));
  const regimeFilter = inferRegimeFromLegacyParams({ rawRegime, rawStatus, rawTokenType });
  const statusFilter = normalizeComplianceStatusFilter(rawStatus, regimeFilter);
  const tokenTypeFilter = regimeFilter === "genius" ? "all" : normalizeMicaTokenTypeFilter(rawTokenType);
  const pegFilter = normalizePegFilter(getParam("peg", getParam("pegCurrency", "all")));

  const setRegimeFilter = useCallback(
    (v: ComplianceRegimeFilter) => {
      trackEvent("filter_applied", { page: "compliance", filter_type: "regime", filter_value: v });
      setParams({ regime: v, status: "all", type: "all", tokenType: "all" });
    },
    [setParams],
  );

  const setStatusFilter = useCallback(
    (v: ComplianceStatusFilter) => {
      trackEvent("filter_applied", { page: "compliance", filter_type: "status", filter_value: v });
      setParam("status", v);
    },
    [setParam],
  );

  const setTokenTypeFilter = useCallback(
    (v: MicaTokenType | "all") => {
      trackEvent("filter_applied", { page: "compliance", filter_type: "type", filter_value: v });
      setParam("type", v);
    },
    [setParam],
  );

  const setPegFilter = useCallback(
    (v: PegCurrency | "all") => {
      trackEvent("filter_applied", { page: "compliance", filter_type: "peg", filter_value: v });
      setParam("peg", v);
    },
    [setParam],
  );

  const [searchInput, setSearchInput] = useState(() => getParam("q"));
  const deferredSearch = useDeferredValue(searchInput);
  const urlSyncTimer = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    urlSyncTimer.current = setTimeout(() => {
      setParam("q", deferredSearch);
      if (deferredSearch) trackSearch("compliance", deferredSearch.length);
    }, 300);
    return () => {
      if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    };
  }, [deferredSearch, setParam]);

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

  const statusOptions = regimeFilter === "genius" ? GENIUS_STATUS_FILTER_OPTIONS : MICA_STATUS_FILTER_OPTIONS;
  const matchingCount = rows.length + watchRows.length;

  return (
    <div className="space-y-6">
      <section id="data" aria-label="Compliance data" tabIndex={-1} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="pharos-kicker">
              {matchingCount === totalTracked
                ? `${totalTracked.toLocaleString()} assessed regime rows`
                : `${matchingCount.toLocaleString()}/${totalTracked.toLocaleString()} matching`}
            </h2>
            <p className="text-xs text-muted-foreground">
              GENIUS effective-date state: {GENIUS_REGIME_STATE.rulemakingPhase.replace(/-/g, " ")} · reviewed{" "}
              {GENIUS_REGIME_STATE.reviewedAt}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              type="single"
              value={regimeFilter}
              onValueChange={(v) => v && setRegimeFilter(v as ComplianceRegimeFilter)}
              className="flex flex-wrap gap-1"
              aria-label="Filter by compliance regime"
            >
              {COMPLIANCE_REGIME_FILTER_OPTIONS.map((f) => (
                <ToggleGroupItem
                  key={f.value}
                  value={f.value}
                  variant="outline"
                  size="sm"
                  className="min-h-[44px] text-xs md:min-h-0"
                >
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {regimeFilter !== "all" ? (
              <ToggleGroup
                type="single"
                value={statusFilter}
                onValueChange={(v) => v && setStatusFilter(v as ComplianceStatusFilter)}
                className="flex flex-wrap gap-1"
                aria-label={`Filter by ${regimeFilter === "mica" ? "MiCA" : "GENIUS"} status`}
              >
                {statusOptions.map((f) => (
                  <ToggleGroupItem
                    key={f.value}
                    value={f.value}
                    variant="outline"
                    size="sm"
                    className="min-h-[44px] text-xs md:min-h-0"
                  >
                    {f.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}
            {regimeFilter !== "genius" ? (
              <ToggleGroup
                type="single"
                value={tokenTypeFilter}
                onValueChange={(v) => v && setTokenTypeFilter(v as MicaTokenType | "all")}
                className="flex gap-1"
                aria-label="Filter by MiCA token type"
              >
                {MICA_TOKEN_TYPE_FILTER_OPTIONS.map((f) => (
                  <ToggleGroupItem
                    key={f.value}
                    value={f.value}
                    variant="outline"
                    size="sm"
                    className="min-h-[44px] text-xs md:min-h-0"
                  >
                    {f.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}
            <ToggleGroup
              type="single"
              value={pegFilter}
              onValueChange={(v) => v && setPegFilter(v as PegCurrency | "all")}
              className="flex gap-1"
              aria-label="Filter by peg currency"
            >
              {PEG_FILTER_OPTIONS.map((f) => (
                <ToggleGroupItem
                  key={f.value}
                  value={f.value}
                  variant="outline"
                  size="sm"
                  className="min-h-[44px] text-xs md:min-h-0"
                >
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
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

        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="pharos-kicker">Authorization Table</p>
                <p className="text-xs text-muted-foreground">
                  Active, assessed stablecoins only. Frozen and pre-launch assets are excluded from the main table.
                </p>
              </div>
              <span className="font-mono text-xs text-muted-foreground">{rows.length.toLocaleString()} rows</span>
            </div>
            {rows.length === 0 ? (
              <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
                {regimeFilter === "genius" && !isGeniusEffective
                  ? "GENIUS rows remain in implementation watch until the regime is effective."
                  : "No stablecoins match these filters."}
              </div>
            ) : (
              <ComplianceTable
                rows={rows}
                logos={logos}
                tableId="compliance-authorization"
                testId="compliance-authorization-table"
                ariaLabel="Compliance authorization table"
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
                <span className="font-mono text-xs text-muted-foreground">
                  {watchRows.length.toLocaleString()} rows
                </span>
              </div>
              {watchRows.length === 0 ? (
                <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
                  No GENIUS implementation-watch rows match these filters.
                </div>
              ) : (
                <ComplianceTable
                  rows={watchRows}
                  logos={logos}
                  tableId="compliance-genius-watch"
                  testId="compliance-genius-watch-table"
                  ariaLabel="GENIUS implementation watch table"
                />
              )}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ComplianceTable({
  rows,
  logos,
  tableId,
  testId,
  ariaLabel,
}: {
  rows: ComplianceRow[];
  logos: Record<string, string> | undefined;
  tableId: string;
  testId: string;
  ariaLabel: string;
}) {
  return (
    <TableFrame
      tableId={tableId}
      testId={testId}
      chrome="bare"
      className="overflow-hidden rounded-2xl border border-border/60 bg-card/40"
      tableProps={{ "aria-label": ariaLabel }}
      viewportClassName="relative w-full"
      viewportProps={{
        compactBottomPadding: false,
        mobileScrollHint: false,
        overscrollX: false,
        scrollShadow: false,
      }}
    >
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Coin</TableHead>
          <TableHead>Regime</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Pathway / Type</TableHead>
          <TableHead>Authority</TableHead>
          <TableHead>Issuer Entity</TableHead>
          <TableHead>Reserve Disclosure</TableHead>
          <TableHead className="text-right">Sources</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <ComplianceTableRow key={`${row.regime}:${row.id}`} row={row} logo={logos?.[row.id]} />
        ))}
      </TableBody>
    </TableFrame>
  );
}

function ComplianceTableRow({ row, logo }: { row: ComplianceRow; logo: string | undefined }) {
  return (
    <TableRow>
      <TableCell>
        <Link
          href={buildStablecoinUrl(row.id)}
          className="pharos-focus-ring inline-flex min-w-0 items-center gap-2 rounded-sm hover:text-foreground"
        >
          <StablecoinLogo src={logo} name={row.name} size={28} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{row.symbol}</span>
            <span className="block truncate text-xs text-muted-foreground">{row.name}</span>
          </span>
        </Link>
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-xs font-semibold">
          {row.regime === "mica" ? "MiCA" : "GENIUS"}
        </span>
      </TableCell>
      <TableCell>{row.regime === "mica" ? <MicaStatusCell row={row} /> : <GeniusStatusCell row={row} />}</TableCell>
      <TableCell>{row.regime === "mica" ? <MicaPathwayCell row={row} /> : <GeniusPathwayCell row={row} />}</TableCell>
      <TableCell>{row.regime === "mica" ? <MicaAuthorityCell row={row} /> : <GeniusAuthorityCell row={row} />}</TableCell>
      <TableCell>
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
      <TableCell>{row.regime === "mica" ? <EmptyCell /> : <GeniusReserveCell row={row} />}</TableCell>
      <TableCell className="text-right">
        <SourceLinks references={row.references} />
      </TableCell>
    </TableRow>
  );
}

function MicaStatusCell({ row }: { row: Extract<ComplianceRow, { regime: "mica" }> }) {
  const status = MICA_STATUS_BADGE_STYLES[row.status];
  return (
    <span
      title={MICA_STATUS_DESCRIPTIONS[row.status]}
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${status.cls}`}
    >
      {status.label}
    </span>
  );
}

function GeniusStatusCell({ row }: { row: Extract<ComplianceRow, { regime: "genius" }> }) {
  const status = GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[row.status];
  return (
    <span
      title={GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS[row.status]}
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${status.cls}`}
    >
      {status.label}
    </span>
  );
}

function MicaPathwayCell({ row }: { row: Extract<ComplianceRow, { regime: "mica" }> }) {
  const tokenType = row.tokenType ? MICA_TOKEN_TYPE_BADGE_STYLES[row.tokenType] : null;
  return (
    <div className="space-y-1">
      {tokenType ? (
        <span
          title={MICA_TOKEN_TYPE_LABELS[row.tokenType!]}
          className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${tokenType.cls}`}
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
          className="inline-flex items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:text-blue-400"
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

function GeniusReserveCell({ row }: { row: Extract<ComplianceRow, { regime: "genius" }> }) {
  if (!row.reserveDisclosurePresent) return <EmptyCell />;
  const content = (
    <>
      Disclosure
      {row.latestReportDate ? <span className="block text-xs text-muted-foreground">{row.latestReportDate}</span> : null}
      {row.redemptionPolicyPresent ? <span className="block text-xs text-muted-foreground">Redemption policy</span> : null}
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

function SourceLinks({ references }: { references: readonly { label: string; url: string }[] }) {
  if (references.length === 0) return <EmptyCell />;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {references.map((reference) => (
        <a
          key={`${reference.label}:${reference.url}`}
          href={reference.url}
          target="_blank"
          rel="noopener noreferrer"
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-frost-blue hover:underline"
        >
          {reference.label}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}

function EmptyCell() {
  return <span className="text-xs text-muted-foreground">-</span>;
}
