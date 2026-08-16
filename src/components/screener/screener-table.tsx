"use client";

import { useRef } from "react";
import Link from "next/link";
import {
  DataTableEmptyRow,
  DataTableLoadingRows,
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { MobileMetricPill, MobileSortPanel, MobileSortPills } from "@/components/mobile-sort-pills";
import { TableCell, TableRow } from "@/components/table";
import { useRowCursor, type UseRowCursorResult } from "@/hooks/use-row-cursor";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSortColumnEvent } from "@/hooks/use-sort-column-event";
import { useWatchlist } from "@/hooks/use-watchlist";
import { useHydrated } from "@/hooks/use-hydrated";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { EmptyStateIllustration } from "@/components/empty-state-illustration";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { StablecoinIdentity } from "@/components/stablecoin-identity";
import { RowSparkline } from "@/components/row-sparkline";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatCompactUsd } from "@shared/lib/format";
import { MINT_AUTHORITY_STATUS_CONFIG } from "@/lib/mint-authority-display";
import { PEG_METADATA, getMechanismArchetypeLabel } from "@shared/lib/classification";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import type { ScreenerRow, ScreenerSortKey } from "@/lib/screener-filters";
import type { DataTableSortControls } from "@/components/data-table-shell";
import type { QueryKey } from "@tanstack/react-query";
import type { ReportCardGrade } from "@shared/types";

// M1: keys feeding the screener table's visible data (supply, peg, DEWS,
// liquidity, safety grade). A background refetch of any of these surfaces the
// RefreshingBar while the prior rows stay visible (keepPreviousData).
const SCREENER_REFRESH_QUERY_KEYS: readonly QueryKey[] = [
  ["stablecoins"],
  ["peg-summary"],
  ["report-cards"],
  ["stress-signals"],
  ["dex-liquidity"],
];

function getRowPegDeviationSeries(row: ScreenerRow): ReadonlyArray<number | null> {
  return row.pegDeviationSeries ?? [];
}

function getRowSupplySeries(row: ScreenerRow): ReadonlyArray<number | null> {
  return row.supplySeries ?? [];
}

const COLUMNS: readonly DataTableColumn<ScreenerSortKey>[] = [
  { id: "name", label: "Name", sortKey: "name", className: "min-w-[160px]" },
  { id: "supply", label: "Supply", sortKey: "supply", className: "text-right" },
  {
    id: "pegScore",
    label: "Peg Score",
    sortKey: "pegScore",
    className: "text-right",
    title: "Peg Stability Score (0-100): peg-holding consistency over 30 days",
  },
  {
    id: "dewsScore",
    label: "DEWS",
    sortKey: "dewsScore",
    className: "text-right",
    title: "Depeg Early Warning System stress score (0-100)",
  },
  {
    id: "liquidityScore",
    label: "Liquidity",
    sortKey: "liquidityScore",
    className: "text-right",
    title: "DEX Liquidity Score (0-100): pool depth, volume, and diversity",
  },
  {
    id: "safetyScore",
    label: "Grade",
    sortKey: "safetyScore",
    className: "text-center",
    title: `Pharos Safety Grade (${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL})`,
  },
  {
    id: "v9Profile",
    label: "V9 Profile",
    className: "text-center",
    title: "Safety Score V9 pillars: Backing / Exit / Economic Control. The weakest published pillar is highlighted.",
  },
  { id: "mechanism", label: "Mechanism", className: "text-left" },
  { id: "peg", label: "Peg", className: "text-left" },
  {
    id: "peg30d",
    label: "30d Peg",
    className: "text-right w-[112px] hidden xl:table-cell",
    title: "30-day peg deviation strip (±bps around the peg)",
  },
  {
    id: "supply30d",
    label: "30d Supply",
    className: "text-right w-[112px] hidden xl:table-cell",
    title: "30-day supply trajectory",
  },
] as const;

const MOBILE_SORT_OPTIONS: Array<{ key: ScreenerSortKey; label: string }> = [
  { key: "safetyScore", label: "Grade" },
  { key: "supply", label: "Supply" },
  { key: "pegScore", label: "Peg" },
  { key: "dewsScore", label: "DEWS" },
  { key: "liquidityScore", label: "Liquidity" },
];

interface ScreenerTableProps {
  rows: readonly ScreenerRow[];
  logos?: Record<string, string>;
  isLoading: boolean;
  onClearFilters?: () => void;
  hasActiveFilters: boolean;
  sort: DataTableSortControls<ScreenerSortKey>;
}

export function ScreenerTable({
  rows,
  logos,
  isLoading,
  onClearFilters,
  hasActiveFilters,
  sort,
}: ScreenerTableProps) {
  const watchlist = useWatchlist();
  const tableRef = useRef<HTMLDivElement>(null);
  const compareLinkRef = useRef<HTMLAnchorElement>(null);
  const isMobileLayout = useIsMobile(768);
  const isBelowXl = useIsMobile(1280);
  const layoutResolved = useHydrated();
  const showDesktopSparklines = layoutResolved && !isBelowXl;

  // P6 — j/k row cursor over the desktop table rows. o/Enter opens the dossier,
  // s toggles the watchlist, c adds to /compare. The hook bails while an input
  // is focused, so typing in the filter toolbar is unaffected.
  //
  // Navigation is performed by clicking real Next <Link> anchors instead of
  // `useRouter().push`, so the table renders without an App Router context
  // (e.g. in unit tests) while keeping client-side routing. `onOpen` clicks the
  // cursor row's own detail link; `onAddToCompare` clicks a hidden per-cursor
  // compare link rendered below.
  const { getRowProps, cursorId } = useRowCursor<ScreenerRow>({
    rows,
    getRowId: (row) => row.id,
    onOpen: (row) => {
      tableRef.current
        ?.querySelector<HTMLAnchorElement>(`[data-screener-open="${row.id}"]`)
        ?.click();
    },
    onToggleStar: (row) => watchlist.toggle(row.id),
    onAddToCompare: () => compareLinkRef.current?.click(),
    scopeRef: tableRef,
    enabled: !isMobileLayout,
  });
  const compareHref = cursorId ? buildLiveCompareUrl([cursorId]) : null;

  // P8 — numeric column sort: providers broadcast the Nth column on keys 1-9.
  // Map it to the matching desktop column and toggle its sort if sortable.
  const toggleSort = sort.toggleSort;
  useSortColumnEvent(COLUMNS, toggleSort);

  if (!layoutResolved) {
    return <ScreenerLayoutPending />;
  }

  if (isMobileLayout) {
    return (
      <div className="space-y-3">
        <MobileSortPanel kicker="Sort Results">
          <MobileSortPills
            options={MOBILE_SORT_OPTIONS}
            sortKey={sort.sortKey}
            sortDirection={sort.sortDirection}
            onSort={sort.toggleSort}
            ariaLabel="Sort screener results"
          />
        </MobileSortPanel>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="pharos-card-shell h-28 animate-pulse rounded-xl bg-muted/20" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <ScreenerEmptyState hasActiveFilters={hasActiveFilters} onClearFilters={onClearFilters} />
        ) : (
          <div className="space-y-3">
            {rows.map((row) => <ScreenerMobileCard key={row.id} row={row} logo={logos?.[row.id]} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={tableRef}>
      {/* Hidden target for the cursor's `c` (add-to-compare) shortcut; a real
            Next <Link> so navigation stays client-side without `useRouter`. */}
      {compareHref ? (
        <Link
          ref={compareLinkRef}
          href={compareHref}
          aria-hidden="true"
          tabIndex={-1}
          className="sr-only"
        >
          Compare cursor row
        </Link>
      ) : null}
      <DataTableShell<ScreenerSortKey>
        tableId="stablecoin-screener"
        testId="stablecoin-screener-table"
        columns={COLUMNS}
        sort={sort}
        striped
        refreshingQueryKeys={SCREENER_REFRESH_QUERY_KEYS}
        isPending={isLoading}
      >
        {isLoading ? (
          <DataTableLoadingRows columns={COLUMNS} rowCount={8} />
        ) : rows.length === 0 ? (
          <DataTableEmptyRow colSpan={COLUMNS.length}>
            <ScreenerEmptyState hasActiveFilters={hasActiveFilters} onClearFilters={onClearFilters} compact />
          </DataTableEmptyRow>
        ) : (
          rows.map((row, index) => (
            <ScreenerTableRow
              key={row.id}
              row={row}
              logo={logos?.[row.id]}
              rowProps={getRowProps(index, row.id)}
              showSparklines={showDesktopSparklines}
            />
          ))
        )}
      </DataTableShell>
    </div>
  );
}

function ScreenerLayoutPending() {
  return (
    <div data-testid="stablecoin-screener-layout-pending" className="space-y-3">
      <MobileSortPanel kicker="Sort Results">
        <div className="flex flex-wrap gap-2" aria-hidden="true">
          {MOBILE_SORT_OPTIONS.map((option) => (
            <span key={option.key} className="h-8 w-16 animate-pulse rounded-full bg-muted/40" />
          ))}
        </div>
      </MobileSortPanel>
      <div className="space-y-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="pharos-card-shell h-28 animate-pulse rounded-xl bg-muted/20" />
        ))}
      </div>
    </div>
  );
}

function ScoreValue({ value }: { value: number | null }) {
  return value != null ? (
    <span className="pharos-numeric text-foreground">{value.toFixed(0)}</span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

function ScreenerEmptyState({
  hasActiveFilters,
  onClearFilters,
  compact = false,
}: {
  hasActiveFilters: boolean;
  onClearFilters?: () => void;
  compact?: boolean;
}) {
  // Cold start is a loading state, not an empty state — the canonical
  // archetypes only cover the zero-rows case.
  if (!hasActiveFilters) {
    return (
      <div className={compact ? "space-y-2" : "rounded-xl border border-dashed border-border/70 bg-background/35 px-4 py-8 text-center text-sm text-muted-foreground"}>
        <p>Loading screener inputs…</p>
      </div>
    );
  }

  return (
    <EmptyStateIllustration
      kind="no-matches"
      title="No stablecoins match these filters."
      className={compact ? "py-6" : "rounded-xl border border-dashed border-border/70 bg-background/35 px-4"}
      action={
        onClearFilters ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-4 py-2 text-sm text-foreground hover:text-foreground/80 md:min-h-9"
          >
            Reset filters and try again.
          </button>
        ) : undefined
      }
    />
  );
}

function ScreenerMobileCard({ row, logo }: { row: ScreenerRow; logo?: string }) {
  return (
    <article className="pharos-card-shell rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <Link
          href={buildStablecoinUrl(row.id)}
          className="pharos-focus-ring flex min-w-0 items-center gap-2 rounded-md"
        >
          <StablecoinIdentity
            layout="contents"
            logoSrc={logo}
            name={row.name}
            symbol={row.symbol}
            logoSize={30}
            symbolClassName="block font-semibold text-foreground"
            nameClassName="block truncate text-xs text-muted-foreground"
          />
        </Link>
        <div className="shrink-0 text-right">
          <p className="pharos-kicker">Supply</p>
          <p className="pharos-numeric text-sm font-semibold text-foreground">
            {row.supplyUsd > 0 ? formatCompactUsd(row.supplyUsd) : "—"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {row.safetyGrade ? (
          <SafetyGradeBadge
            grade={row.safetyGrade as ReportCardGrade}
            score={row.safetyScore}
            size="sm"
          />
        ) : (
          <span className="rounded-full border border-border/60 px-2 py-1">Grade —</span>
        )}
        <MobileMetricPill>Peg <ScoreValue value={row.pegScore} /></MobileMetricPill>
        <MobileMetricPill>DEWS <ScoreValue value={row.dewsScore} /></MobileMetricPill>
        <MobileMetricPill>Liq <ScoreValue value={row.liquidityScore} /></MobileMetricPill>
        <V9Profile row={row} compact />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl border border-border/60 bg-background/45 px-3 py-2">
          <p className="text-muted-foreground">Mechanism</p>
          <p className="mt-0.5 truncate font-medium text-foreground">
            {row.mechanism ? getMechanismArchetypeLabel(row.mechanism) : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/45 px-3 py-2">
          <p className="text-muted-foreground">Peg</p>
          <p className="mt-0.5 font-medium text-foreground">
            {PEG_METADATA[row.peg]?.filterLabel ?? row.peg}
          </p>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/45 px-3 py-2">
          <p className="text-muted-foreground">Mint authority</p>
          <p className="mt-0.5 font-medium text-foreground">
            {row.mintAuthorityScoreLabel} / {MINT_AUTHORITY_STATUS_CONFIG[row.mintAuthority].spokenLabel}
          </p>
        </div>
      </div>
    </article>
  );
}

function DesktopScoreCell({ value }: { value: number | null }) {
  return (
    <TableCell className="text-right pharos-numeric">
      <ScoreValue value={value} />
    </TableCell>
  );
}

function ScreenerTableRow({
  row,
  logo,
  rowProps,
  showSparklines,
}: {
  row: ScreenerRow;
  logo?: string;
  rowProps?: ReturnType<UseRowCursorResult["getRowProps"]>;
  showSparklines: boolean;
}) {
  return (
    <TableRow
      {...rowProps}
      className="hover:!transform-none data-[cursor=true]:bg-muted/40 data-[cursor=true]:shadow-[inset_3px_0_0_0_var(--brand-accent)]"
    >
      <TableCell className="min-w-[160px]">
        <Link
          href={buildStablecoinUrl(row.id)}
          data-screener-open={row.id}
          className="pharos-focus-ring inline-flex min-w-0 items-center gap-2 rounded-sm"
        >
          <StablecoinIdentity
            layout="contents"
            logoSrc={logo}
            name={row.name}
            symbol={row.symbol}
            logoSize={24}
            symbolClassName="block font-semibold text-foreground"
            nameClassName="block truncate text-xs text-muted-foreground"
          />
        </Link>
      </TableCell>
      <TableCell className="text-right pharos-numeric">
        {row.supplyUsd > 0 ? formatCompactUsd(row.supplyUsd) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <DesktopScoreCell value={row.pegScore} />
      <DesktopScoreCell value={row.dewsScore} />
      <DesktopScoreCell value={row.liquidityScore} />
      <TableCell className="text-center">
        {row.safetyGrade ? (
          <SafetyGradeBadge
            grade={row.safetyGrade as ReportCardGrade}
            score={row.safetyScore}
            size="sm"
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-center">
        <V9Profile row={row} />
      </TableCell>
      <TableCell className="text-left text-muted-foreground">
        {row.mechanism ? getMechanismArchetypeLabel(row.mechanism) : "—"}
      </TableCell>
      <TableCell className="text-left text-muted-foreground">
        {PEG_METADATA[row.peg]?.filterLabel ?? row.peg}
      </TableCell>
      <TableCell
        data-column-id="peg30d"
        className="text-right w-[112px] hidden xl:table-cell"
      >
        {showSparklines ? (
          <RowSparkline
            data={getRowPegDeviationSeries(row)}
            signed
            referenceValue={0}
            ariaLabel={`30-day peg deviation for ${row.symbol}`}
            width={96}
            height={16}
          />
        ) : null}
      </TableCell>
      <TableCell
        data-column-id="supply30d"
        className="text-right w-[112px] hidden xl:table-cell"
      >
        {showSparklines ? (
          <RowSparkline
            data={getRowSupplySeries(row)}
            ariaLabel={`30-day supply trajectory for ${row.symbol}`}
            width={96}
            height={16}
          />
        ) : null}
      </TableCell>
    </TableRow>
  );
}

const EVIDENCE_BADGE_CLASSES: Record<ScreenerRow["safetyEvidence"], string> = {
  strong: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  adequate: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  limited: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  nr: "border-border/60 bg-muted/30 text-muted-foreground",
};

const EVIDENCE_LABELS: Record<ScreenerRow["safetyEvidence"], string> = {
  strong: "Strong",
  adequate: "Adequate",
  limited: "Limited",
  nr: "NR",
};

function V9Profile({ row, compact = false }: { row: ScreenerRow; compact?: boolean }) {
  const title = row.safetyBindingCapReason
    ? `Binding V9 cap: ${row.safetyBindingCapReason}`
    : `V9 evidence: ${EVIDENCE_LABELS[row.safetyEvidence]}`;
  return (
    <span className={`inline-flex ${compact ? "items-center" : "flex-col"} gap-1`} title={title}>
      <span className="inline-flex items-center gap-1 pharos-numeric text-xs">
        <PillarReading label="B" value={row.safetyBackingScore} weakest={row.safetyWeakestPillar === "backing"} />
        <span className="text-border">/</span>
        <PillarReading label="E" value={row.safetyExitScore} weakest={row.safetyWeakestPillar === "exit"} />
        <span className="text-border">/</span>
        <PillarReading label="C" value={row.safetyControlScore} weakest={row.safetyWeakestPillar === "control"} />
      </span>
      <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${EVIDENCE_BADGE_CLASSES[row.safetyEvidence]}`}>
        {EVIDENCE_LABELS[row.safetyEvidence]}
      </span>
    </span>
  );
}

function PillarReading({
  label,
  value,
  weakest,
}: {
  label: "B" | "E" | "C";
  value: number | null;
  weakest: boolean;
}) {
  return (
    <span className={weakest ? "font-bold text-amber-700 dark:text-amber-300" : "text-foreground"}>
      <span className="text-muted-foreground">{label}</span>{value == null ? "—" : Math.round(value)}
    </span>
  );
}
