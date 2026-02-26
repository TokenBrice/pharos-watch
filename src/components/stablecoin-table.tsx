"use client";

import { useState, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, Columns3 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { formatCurrency, formatNativePrice, formatPegDeviation, formatPercentChange } from "@/lib/format";
import { downloadCsv } from "@/lib/csv-export";
import { getPegReference } from "@/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@/lib/supply";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID, TRACKED_IDS } from "@/lib/stablecoins";
import type { StablecoinData, FilterTag, PegSummaryCoin, DexLiquidityMap, ReportCard } from "@/lib/types";
import { getFilterTags, OTHER_PEG_TAGS } from "@/lib/types";
import { BACKING_COLORS, GOVERNANCE_COLORS, BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT } from "@/lib/classification";
import { REPORT_CARD_GRADE_COLORS } from "@/lib/report-cards";
import { deviationColorClass, getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SortableTableHead } from "@/components/sortable-table-head";
import { useSort } from "@/hooks/use-sort";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import {
  usePreference,
  ALL_COLUMNS,
  DEFAULT_VISIBLE_COLUMNS,
  LOCKED_COLUMNS,
  type ColumnId,
} from "@/hooks/use-preferences";

const ROW_HEIGHT = 37;
const OVERSCAN = 10;

interface StablecoinTableProps {
  data: StablecoinData[] | undefined;
  isLoading: boolean;
  activeFilters: FilterTag[];
  logos?: Record<string, string>;
  pegRates?: Record<string, number>;
  searchQuery?: string;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityMap;
  reportCards?: Record<string, ReportCard>;
  onClearSearch?: () => void;
  onClearFilters?: () => void;
}

function MiniSparkline({ values }: { values: number[] }) {
  if (values.length < 2 || values.every(v => v === 0)) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const h = 16;
  const w = 40;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(" ");
  const trending = values[values.length - 1] >= values[0];
  return (
    <svg width={w} height={h} viewBox="0 0 40 16" className="inline-block align-middle mr-1" aria-hidden="true">
      <polyline points={points} fill="none" stroke={trending ? "var(--color-green-500, #22c55e)" : "var(--color-red-500, #ef4444)"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─── Column Visibility Dropdown ─────────────────────────── */

function ColumnVisibilityDropdown({
  visibleColumns,
  setVisibleColumns,
  resetColumns,
}: {
  visibleColumns: ColumnId[];
  setVisibleColumns: (value: ColumnId[] | ((prev: ColumnId[]) => ColumnId[])) => void;
  resetColumns: () => void;
}) {
  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const hiddenCount = ALL_COLUMNS.length - visibleColumns.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Columns3 className="h-3.5 w-3.5" />
          Columns
          {hiddenCount > 0 && (
            <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold w-4 h-4">
              {hiddenCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs">Toggle columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ALL_COLUMNS.map((col) => (
          <DropdownMenuCheckboxItem
            key={col.id}
            checked={visibleSet.has(col.id)}
            disabled={LOCKED_COLUMNS.has(col.id)}
            onCheckedChange={(checked) => {
              setVisibleColumns((prev) =>
                checked
                  ? [...prev, col.id]
                  : prev.filter((c) => c !== col.id)
              );
            }}
            onSelect={(e) => e.preventDefault()}
          >
            {col.label}
          </DropdownMenuCheckboxItem>
        ))}
        {hiddenCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={false}
              onCheckedChange={() => resetColumns()}
              onSelect={(e) => e.preventDefault()}
              className="text-xs text-muted-foreground"
            >
              Reset to defaults
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


export function StablecoinTable({ data, isLoading, activeFilters, logos, pegRates = {}, searchQuery, pegScores, dexLiquidity, reportCards, onClearSearch, onClearFilters }: StablecoinTableProps) {
  type SortKey = "name" | "price" | "mcap" | "change24h" | "change7d" | "stability" | "liquidity" | "grade";
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } = useSort<SortKey>("mcap", "desc");
  const sort = useMemo(() => ({ key: sortKey, direction: sortDirection }), [sortKey, sortDirection]);
  const router = useRouter();
  const prefetch = usePrefetchStablecoin();
  const metaById = TRACKED_META_BY_ID;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Column visibility
  const [visibleColumns, setVisibleColumns, resetColumns] = usePreference<ColumnId[]>(
    "pharos-table-columns",
    DEFAULT_VISIBLE_COLUMNS,
  );
  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const isVisible = useCallback((id: ColumnId) => visibleSet.has(id), [visibleSet]);

  // If the current sort column is hidden, fall back to mcap
  const effectiveSortKey = useMemo(() => {
    const SORT_KEY_TO_COLUMN: Record<SortKey, ColumnId> = {
      name: "name",
      price: "price",
      mcap: "mcap",
      change24h: "change24h",
      change7d: "change7d",
      stability: "stability",
      liquidity: "liquidity",
      grade: "grade",
    };
    const colId = SORT_KEY_TO_COLUMN[sortKey];
    return visibleSet.has(colId) ? sortKey : "mcap" as SortKey;
  }, [sortKey, visibleSet]);

  const trackedIds = useMemo(() => {
    if (activeFilters.length === 0) {
      return TRACKED_IDS;
    }
    return new Set(
      TRACKED_STABLECOINS.filter((s) => {
        const tags = getFilterTags(s);
        return activeFilters.every((f) =>
          f === "other-peg" ? tags.some((t) => OTHER_PEG_TAGS.includes(t)) : tags.includes(f)
        );
      }).map((s) => s.id)
    );
  }, [activeFilters]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = searchQuery?.toLowerCase().trim() ?? "";
    return data.filter((coin) => {
      if (!trackedIds.has(coin.id)) return false;
      if (q && !coin.name.toLowerCase().includes(q) && !coin.symbol.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, trackedIds, searchQuery]);

  const sorted = useMemo(() => {
    const sk = effectiveSortKey;
    return [...filtered].sort((a, b) => {
      let aVal: number, bVal: number;
      switch (sk) {
        case "name":
          return sort.direction === "asc"
            ? a.name.localeCompare(b.name)
            : b.name.localeCompare(a.name);
        case "price":
          aVal = a.price ?? 0;
          bVal = b.price ?? 0;
          break;
        case "mcap":
          aVal = getCirculatingRaw(a);
          bVal = getCirculatingRaw(b);
          break;
        case "change24h": {
          const aPrev24 = getPrevDayRaw(a);
          const bPrev24 = getPrevDayRaw(b);
          aVal = aPrev24 > 0 ? (getCirculatingRaw(a) - aPrev24) / aPrev24 : 0;
          bVal = bPrev24 > 0 ? (getCirculatingRaw(b) - bPrev24) / bPrev24 : 0;
          break;
        }
        case "change7d": {
          const aPrev7 = getPrevWeekRaw(a);
          const bPrev7 = getPrevWeekRaw(b);
          aVal = aPrev7 > 0 ? (getCirculatingRaw(a) - aPrev7) / aPrev7 : 0;
          bVal = bPrev7 > 0 ? (getCirculatingRaw(b) - bPrev7) / bPrev7 : 0;
          break;
        }
        case "stability": {
          const aScore = pegScores?.get(a.id)?.pegScore ?? null;
          const bScore = pegScores?.get(b.id)?.pegScore ?? null;
          if (aScore === null && bScore === null) return 0;
          if (aScore === null) return 1;
          if (bScore === null) return -1;
          aVal = aScore;
          bVal = bScore;
          break;
        }
        case "liquidity": {
          const aLiq = dexLiquidity?.[a.id]?.liquidityScore ?? null;
          const bLiq = dexLiquidity?.[b.id]?.liquidityScore ?? null;
          if (aLiq === null && bLiq === null) return 0;
          if (aLiq === null) return 1;
          if (bLiq === null) return -1;
          aVal = aLiq;
          bVal = bLiq;
          break;
        }
        case "grade": {
          const aGrade = reportCards?.[a.id]?.overallScore ?? null;
          const bGrade = reportCards?.[b.id]?.overallScore ?? null;
          if (aGrade === null && bGrade === null) return 0;
          if (aGrade === null) return 1;
          if (bGrade === null) return -1;
          aVal = aGrade;
          bVal = bGrade;
          break;
        }
        default:
          aVal = getCirculatingRaw(a);
          bVal = getCirculatingRaw(b);
      }
      return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [filtered, sort, effectiveSortKey, pegScores, dexLiquidity, reportCards]);

  // Reset scroll when filters, search, or sort change
  const [prev, setPrev] = useState({ filtered, sort });
  if (prev.filtered !== filtered || prev.sort !== sort) {
    setPrev({ filtered, sort });
    scrollRef.current?.scrollTo({ top: 0 });
  }

  // Virtual scrolling
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0
    ? totalHeight - virtualItems[virtualItems.length - 1].end
    : 0;

  // Visible range for footer
  const rangeStart = virtualItems.length > 0 ? virtualItems[0].index + 1 : 0;
  const rangeEnd = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index + 1 : 0;

  const handleCsvExport = useCallback(() => {
    // CSV always exports all columns regardless of visibility
    downloadCsv(sorted, [
      { header: "Rank", accessor: (_row, i) => i + 1 },
      { header: "Name", accessor: (row) => row.name },
      { header: "Symbol", accessor: (row) => row.symbol },
      { header: "Price", accessor: (row) => row.price ?? null },
      { header: "Market Cap (USD)", accessor: (row) => getCirculatingRaw(row) },
      {
        header: "24h Change (%)",
        accessor: (row) => {
          const prev = getPrevDayRaw(row);
          if (prev <= 0) return null;
          return Number((((getCirculatingRaw(row) - prev) / prev) * 100).toFixed(2));
        },
      },
      {
        header: "7d Change (%)",
        accessor: (row) => {
          const prev = getPrevWeekRaw(row);
          if (prev <= 0) return null;
          return Number((((getCirculatingRaw(row) - prev) / prev) * 100).toFixed(2));
        },
      },
      { header: "Peg Score", accessor: (row) => pegScores?.get(row.id)?.pegScore ?? null },
      { header: "Liquidity Score", accessor: (row) => dexLiquidity?.[row.id]?.liquidityScore ?? null },
      { header: "Grade", accessor: (row) => reportCards?.[row.id]?.overallGrade ?? null },
    ], "pharos-stablecoins");
  }, [sorted, pegScores, dexLiquidity, reportCards]);

  if (isLoading) {
    return (
      <div className="rounded-xl border overflow-hidden">
        <div className="bg-muted/50 h-10" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2 border-t">
            <Skeleton className="h-4 w-8 shrink-0" />
            <Skeleton className="h-6 w-6 rounded-full shrink-0" />
            <Skeleton className="h-4 w-28" />
            <div className="flex-1" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-12 hidden sm:block" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-14 hidden sm:block" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-xl border animate-in fade-in duration-300">
      <div className="flex items-center justify-end gap-2 px-3 py-1.5 border-b bg-muted/30">
        <ColumnVisibilityDropdown
          visibleColumns={visibleColumns}
          setVisibleColumns={setVisibleColumns}
          resetColumns={resetColumns}
        />
        <Button variant="outline" size="sm" onClick={handleCsvExport} disabled={sorted.length === 0}>
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>

      {/* Scroll container — handles both horizontal and vertical overflow */}
      <div
        ref={scrollRef}
        className="overflow-auto max-h-[50vh] sm:max-h-[70vh] scroll-shadow"
      >
        <table className="w-full caption-bottom text-sm">
          <TableHeader className="bg-muted/50 sticky top-0 z-10 backdrop-blur-sm">
            <TableRow>
              {isVisible("rank") && (
                <TableHead className="w-[50px] text-right">#</TableHead>
              )}
              {isVisible("name") && (
                <SortableTableHead
                  sortKey="name"
                  currentSortKey={sortKey}
                  sortDirection={sortDirection}
                  label="Name"
                  toggleSort={toggleSort}
                  getAriaSortValue={getAriaSortValue}
                  handleSortKeyDown={handleSortKeyDown}
                  className="w-[90px] xl:w-[200px]"
                />
              )}
              {isVisible("price") && (
                <SortableTableHead
                  sortKey="price"
                  currentSortKey={sortKey}
                  sortDirection={sortDirection}
                  label="Price"
                  toggleSort={toggleSort}
                  getAriaSortValue={getAriaSortValue}
                  handleSortKeyDown={handleSortKeyDown}
                  className="text-right"
                />
              )}
              {isVisible("peg") && (
                <TableHead className="text-right" title="Current peg deviation from target price">Peg</TableHead>
              )}
              {isVisible("mcap") && (
                <SortableTableHead
                  sortKey="mcap"
                  currentSortKey={sortKey}
                  sortDirection={sortDirection}
                  label="Market Cap"
                  toggleSort={toggleSort}
                  getAriaSortValue={getAriaSortValue}
                  handleSortKeyDown={handleSortKeyDown}
                  className="text-right"
                />
              )}
              {isVisible("change24h") && (
                <SortableTableHead
                  sortKey="change24h"
                  currentSortKey={sortKey}
                  sortDirection={sortDirection}
                  label="24h"
                  toggleSort={toggleSort}
                  getAriaSortValue={getAriaSortValue}
                  handleSortKeyDown={handleSortKeyDown}
                  className="text-right"
                  title="24-hour market cap change"
                />
              )}
              {isVisible("change7d") && (
                <SortableTableHead
                  sortKey="change7d"
                  currentSortKey={sortKey}
                  sortDirection={sortDirection}
                  label="7d"
                  toggleSort={toggleSort}
                  getAriaSortValue={getAriaSortValue}
                  handleSortKeyDown={handleSortKeyDown}
                  className="hidden sm:table-cell text-right"
                  title="7-day market cap change"
                />
              )}
              {isVisible("grade") && (
                <SortableTableHead
                  sortKey="grade"
                  currentSortKey={sortKey}
                  sortDirection={sortDirection}
                  label="Grade"
                  toggleSort={toggleSort}
                  getAriaSortValue={getAriaSortValue}
                  handleSortKeyDown={handleSortKeyDown}
                  className="hidden md:table-cell text-center"
                  title="Pharos Grade — overall report card score across peg stability, liquidity, resilience, decentralization, and dependency risk"
                />
              )}
              {isVisible("stability") && (
                <SortableTableHead
                  sortKey="stability"
                  currentSortKey={sortKey}
                  sortDirection={sortDirection}
                  label="Peg Score"
                  toggleSort={toggleSort}
                  getAriaSortValue={getAriaSortValue}
                  handleSortKeyDown={handleSortKeyDown}
                  className="hidden sm:table-cell text-right"
                  title="Peg Stability Score (0-100): measures peg-holding consistency over 30 days"
                />
              )}
              {isVisible("liquidity") && (
                <SortableTableHead
                  sortKey="liquidity"
                  currentSortKey={sortKey}
                  sortDirection={sortDirection}
                  label="Liq"
                  toggleSort={toggleSort}
                  getAriaSortValue={getAriaSortValue}
                  handleSortKeyDown={handleSortKeyDown}
                  className="hidden sm:table-cell text-right"
                  title="DEX Liquidity Score — measures pool depth, volume, and diversity across decentralized exchanges"
                />
              )}
              {isVisible("backing") && (
                <TableHead className="hidden md:table-cell text-center" title="Collateral backing type">Backing</TableHead>
              )}
              {isVisible("type") && (
                <TableHead className="hidden md:table-cell text-center" title="Stablecoin mechanism type">Type</TableHead>
              )}
              {isVisible("flags") && (
                <TableHead className="hidden md:table-cell text-center">Flags</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paddingTop > 0 && (
              <tr><td style={{ height: paddingTop, padding: 0 }} /></tr>
            )}
            {virtualItems.map((virtualRow) => {
              const coin = sorted[virtualRow.index];
              const index = virtualRow.index;
              const circulating = getCirculatingRaw(coin);
              const prevDay = getPrevDayRaw(coin);
              const prevWeek = getPrevWeekRaw(coin);
              const meta = metaById.get(coin.id);
              const change24h = prevDay > 0 ? ((circulating - prevDay) / prevDay) * 100 : 0;
              const change7d = prevWeek > 0 ? ((circulating - prevWeek) / prevWeek) * 100 : 0;

              return (
                <TableRow
                  key={coin.id}
                  className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => router.push(`/stablecoin/${coin.id}`)}
                  onMouseEnter={() => prefetch(coin.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(`/stablecoin/${coin.id}`); } }}
                  tabIndex={0}
                >
                  {isVisible("rank") && (
                    <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                      {index + 1}
                    </TableCell>
                  )}
                  {isVisible("name") && (
                    <TableCell>
                      <Link
                        href={`/stablecoin/${coin.id}`}
                        className="flex items-center gap-2 font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                        onMouseEnter={() => prefetch(coin.id)}
                      >
                        <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={24} />
                        <span className="font-medium">{coin.symbol}</span>
                        <span className="truncate max-w-[180px] text-xs text-muted-foreground hidden xl:inline">{coin.name}</span>
                      </Link>
                    </TableCell>
                  )}
                  {isVisible("price") && (
                    <TableCell className="text-right font-mono tabular-nums">
                      {(() => {
                        const ref = getPegReference(coin.pegType, pegRates, meta?.commodityOunces);
                        return formatNativePrice(coin.price, meta?.flags.pegCurrency ?? "USD", ref);
                      })()}
                    </TableCell>
                  )}
                  {isVisible("peg") && (
                    <TableCell className="text-right font-mono tabular-nums">
                      {meta?.flags.navToken ? (
                        <span className="text-muted-foreground" title={meta.flags.pegCurrency === "VAR" ? "CPI-indexed — price tracks inflation" : "NAV token — price appreciates with yield"}>
                          {meta.flags.pegCurrency === "VAR" ? "CPI" : "NAV"}
                        </span>
                      ) : (() => {
                        const ref = getPegReference(coin.pegType, pegRates, meta?.commodityOunces);
                        const price = coin.price;
                        const absBps = (price != null && typeof price === "number" && ref > 0)
                          ? Math.abs(price / ref - 1) * 10_000
                          : null;
                        const colorClass = absBps === null
                          ? "text-muted-foreground"
                          : deviationColorClass(absBps);
                        return (
                          <span className={colorClass}>
                            {formatPegDeviation(price, ref)}
                          </span>
                        );
                      })()}
                    </TableCell>
                  )}
                  {isVisible("mcap") && (
                    <TableCell className="text-right font-mono tabular-nums">{formatCurrency(circulating)}</TableCell>
                  )}
                  {isVisible("change24h") && (
                    <TableCell className="text-right font-mono tabular-nums text-sm">
                      <span className={change24h >= 0 ? "text-green-500" : "text-red-500"}>
                        {prevDay > 0 ? (
                          <>{change24h >= 0 ? "↑" : "↓"} {formatPercentChange(circulating, prevDay)}</>
                        ) : "N/A"}
                      </span>
                    </TableCell>
                  )}
                  {isVisible("change7d") && (
                    <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums text-sm">
                      <span className={change7d >= 0 ? "text-green-500" : "text-red-500"}>
                        {prevWeek > 0 ? (
                          <>
                            <span className="hidden sm:inline">
                              <MiniSparkline values={[getPrevWeekRaw(coin), getPrevDayRaw(coin), getCirculatingRaw(coin)]} />
                            </span>
                            {change7d >= 0 ? "↑" : "↓"} {formatPercentChange(circulating, prevWeek)}
                          </>
                        ) : "N/A"}
                      </span>
                    </TableCell>
                  )}
                  {isVisible("grade") && (
                    <TableCell className="hidden md:table-cell px-3 py-2 text-center">
                      {reportCards?.[coin.id] && (
                        <Badge
                          variant="outline"
                          className={`text-xs font-mono px-1 py-0 ${REPORT_CARD_GRADE_COLORS[reportCards[coin.id].overallGrade]}`}
                          title={`Pharos grade: ${reportCards[coin.id].overallGrade}${reportCards[coin.id].overallScore ? ` (${reportCards[coin.id].overallScore}/100)` : ""}`}
                        >
                          {reportCards[coin.id].overallGrade}
                        </Badge>
                      )}
                    </TableCell>
                  )}
                  {isVisible("stability") && (
                    <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums text-sm">
                      {(() => {
                        if (meta?.flags.navToken) {
                          return <span className="text-muted-foreground">—</span>;
                        }
                        const pegCoin = pegScores?.get(coin.id);
                        if (!pegCoin || pegCoin.pegScore === null) {
                          return <span className="text-muted-foreground">—</span>;
                        }
                        const score = pegCoin.pegScore;
                        return <span className={pegScoreColor(score)}>{score}</span>;
                      })()}
                    </TableCell>
                  )}
                  {isVisible("liquidity") && (
                    <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums text-sm">
                      {(() => {
                        const liq = dexLiquidity?.[coin.id];
                        if (!liq || liq.liquidityScore === null || liq.liquidityScore === 0) {
                          return <span className="text-muted-foreground">—</span>;
                        }
                        const score = liq.liquidityScore;
                        return <span className={getScoreColor(score)}>{score}</span>;
                      })()}
                    </TableCell>
                  )}
                  {isVisible("backing") && (
                    <TableCell className="hidden md:table-cell text-center">
                      {meta && (
                        <Badge variant="outline" className={`text-xs ${BACKING_COLORS[meta.flags.backing] ?? ""}`}>
                          {BACKING_LABELS_SHORT[meta.flags.backing]}
                        </Badge>
                      )}
                    </TableCell>
                  )}
                  {isVisible("type") && (
                    <TableCell className="hidden md:table-cell text-center">
                      {meta && (
                        <Badge variant="outline" className={`text-xs ${GOVERNANCE_COLORS[meta.flags.governance] ?? ""}`}>
                          {GOVERNANCE_LABELS_SHORT[meta.flags.governance]}
                        </Badge>
                      )}
                    </TableCell>
                  )}
                  {isVisible("flags") && (
                    <TableCell className="hidden md:table-cell">
                      <div className="flex flex-wrap gap-1 justify-center">
                        {meta?.flags.pegCurrency !== "USD" && (
                          <Badge variant="secondary" className="text-xs">
                            {meta?.flags.pegCurrency}
                          </Badge>
                        )}
                        {meta?.flags.yieldBearing && (
                          <Badge variant="secondary" className="text-xs bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                            Yield
                          </Badge>
                        )}
                        {meta?.flags.rwa && (
                          <Badge variant="secondary" className="text-xs bg-sky-500/10 text-sky-500 border-sky-500/20">
                            RWA
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
            {paddingBottom > 0 && (
              <tr><td style={{ height: paddingBottom, padding: 0 }} /></tr>
            )}
            {sorted.length === 0 && (
              <TableRow>
                <TableCell colSpan={99} className="text-center text-muted-foreground py-8">
                  <p>{searchQuery ? `No results for "${searchQuery}"` : "No stablecoin data available"}</p>
                  {(searchQuery || activeFilters.length > 0) && (
                    <p className="mt-2 text-sm">
                      {searchQuery && onClearSearch && (
                        <button onClick={onClearSearch} className="text-primary hover:underline cursor-pointer text-sm">
                          Clear search
                        </button>
                      )}
                      {searchQuery && activeFilters.length > 0 && onClearSearch && onClearFilters && (
                        <span className="mx-1.5">or</span>
                      )}
                      {activeFilters.length > 0 && onClearFilters && (
                        <button onClick={onClearFilters} className="text-primary hover:underline cursor-pointer text-sm">
                          Clear filters
                        </button>
                      )}
                    </p>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </table>
      </div>

      {/* Scroll position footer */}
      {sorted.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2 border-t text-sm text-muted-foreground">
          <span aria-live="polite">
            Showing {rangeStart}–{rangeEnd} of {sorted.length} stablecoins
          </span>
        </div>
      )}
    </div>
  );
}
