"use client";

import { useMemo, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TableBody, TableCell, TableHead, TableCaption, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Download } from "lucide-react";
import { formatCurrency, formatNativePrice, formatPegDeviation, formatPercentChange } from "@shared/lib/format";
import { getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { StablecoinData, FilterTag, PegSummaryCoin, DexLiquidityMap, ReportCard } from "@shared/types";
import {
  BACKING_COLORS,
  GOVERNANCE_COLORS,
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
} from "@shared/lib/classification";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { deviationColorClass, getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import { buildStablecoinUrl } from "@/lib/urls";
import { DeviationIcon } from "@/components/severity-icon";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SortableTableHead } from "@/components/sortable-table-head";
import { useSort } from "@/hooks/use-sort";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { usePreference, DEFAULT_VISIBLE_COLUMNS, MOBILE_DEFAULT_COLUMNS, type ColumnId } from "@/hooks/use-preferences";
import { ColumnVisibilityDropdown } from "@/components/stablecoin-table-column-visibility";
import { MethodologyLabel } from "@/components/methodology-hint";
import {
  buildTrackedIdSet,
  exportStablecoinsCsv,
  filterStablecoins,
  resolveEffectiveSortKey,
  sortStablecoins,
  type StablecoinTableSortKey,
} from "@/components/stablecoin-table-logic";

const SKELETON_ROWS = Array.from({ length: 10 }, (_, i) => i);
const ROW_HEIGHT = 40;
const OVERSCAN = 12;

interface StablecoinHeaderDef {
  id: ColumnId;
  label: React.ReactNode;
  className?: string;
  title?: string;
  sortKey?: StablecoinTableSortKey;
}

const STABLECOIN_HEADER_DEFS: readonly StablecoinHeaderDef[] = [
  { id: "rank", label: "#", className: "w-[50px] text-right" },
  { id: "name", label: "Name", sortKey: "name", className: "w-[90px] xl:w-[200px] max-w-[90px] xl:max-w-none" },
  { id: "price", label: "Price", sortKey: "price", className: "text-right" },
  {
    id: "peg",
    label: "Peg",
    sortKey: "peg",
    className: "text-right",
    title: "Sort by peg deviation — ascending shows tightest pegs first, descending shows worst depegs first",
  },
  { id: "mcap", label: "Market Cap", sortKey: "mcap", className: "text-right" },
  { id: "change24h", label: "24h", sortKey: "change24h", className: "text-right", title: "24-hour market cap change" },
  { id: "change7d", label: "7d", sortKey: "change7d", className: "text-right", title: "7-day market cap change" },
  {
    id: "grade",
    label: <MethodologyLabel topic="safetyScore">Grade</MethodologyLabel>,
    sortKey: "grade",
    className: "text-center",
    title: "Pharos Grade: overall safety score across peg stability, liquidity, resilience, decentralization, and dependency risk",
  },
  {
    id: "stability",
    label: <MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel>,
    sortKey: "stability",
    className: "text-right",
    title: "Peg Stability Score (0-100): measures peg-holding consistency over 30 days",
  },
  {
    id: "liquidity",
    label: <MethodologyLabel topic="liquidityScore">Liq</MethodologyLabel>,
    sortKey: "liquidity",
    className: "text-right",
    title: "DEX Liquidity Score: measures pool depth, volume, and diversity across decentralized exchanges",
  },
  { id: "backing", label: "Backing", className: "text-center", title: "Collateral backing type" },
  { id: "type", label: "Type", className: "text-center", title: "Stablecoin mechanism type" },
  { id: "flags", label: "Flags", className: "text-center" },
] as const;

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
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const min = values.reduce((m, v) => Math.min(m, v), Infinity);
  const max = values.reduce((m, v) => Math.max(m, v), -Infinity);
  const range = max - min || 1;
  const h = 16;
  const w = 40;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x},${y}`;
    })
    .join(" ");
  const trending = values[values.length - 1] >= values[0];
  return (
    <svg width={w} height={h} viewBox="0 0 40 16" className="inline-block align-middle mr-1" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={trending ? "var(--color-green-500, #22c55e)" : "var(--color-red-500, #ef4444)"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StablecoinTable({
  data,
  isLoading,
  activeFilters,
  logos,
  pegRates = {},
  searchQuery,
  pegScores,
  dexLiquidity,
  reportCards,
  onClearSearch,
  onClearFilters,
}: StablecoinTableProps) {
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } = useSort<StablecoinTableSortKey>(
    "mcap",
    "desc",
  );
  const sort = useMemo(() => ({ key: sortKey, direction: sortDirection }), [sortKey, sortDirection]);
  const router = useRouter();
  const prefetch = usePrefetchStablecoin();
  const metaById = TRACKED_META_BY_ID;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Column visibility — mobile gets a reduced default (hiddenMobile columns start off)
  const deviceDefault = useMemo(
    () => (typeof window !== "undefined" && window.innerWidth < 640 ? MOBILE_DEFAULT_COLUMNS : DEFAULT_VISIBLE_COLUMNS),
    [],
  );
  const [visibleColumns, setVisibleColumns, resetColumns] = usePreference<ColumnId[]>(
    "pharos-table-columns",
    deviceDefault,
  );
  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const isVisible = useCallback((id: ColumnId) => visibleSet.has(id), [visibleSet]);

  const effectiveSortKey = useMemo(() => resolveEffectiveSortKey(sortKey, visibleSet), [sortKey, visibleSet]);

  const trackedIds = useMemo(() => buildTrackedIdSet(activeFilters), [activeFilters]);

  const filtered = useMemo(() => filterStablecoins(data, trackedIds, searchQuery), [data, trackedIds, searchQuery]);

  const sorted = useMemo(
    () =>
      sortStablecoins({
        filtered,
        sort,
        effectiveSortKey,
        pegRates,
        pegScores,
        dexLiquidity,
        reportCards,
      }),
    [filtered, sort, effectiveSortKey, pegRates, pegScores, dexLiquidity, reportCards],
  );

  // Reset scroll when filters, search, or sort change.
  const prevRef = useRef<{ filtered: typeof filtered; sort: typeof sort } | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    if (prev && (prev.filtered !== filtered || prev.sort !== sort)) {
      scrollRef.current?.scrollTo({ top: 0 });
    }
    prevRef.current = { filtered, sort };
  }, [filtered, sort]);

  // Virtual scrolling
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is intentional for large datasets.
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0 ? totalHeight - virtualItems[virtualItems.length - 1].end : 0;

  // Visible range for footer
  const rangeStart = virtualItems.length > 0 ? virtualItems[0].index + 1 : 0;
  const rangeEnd = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index + 1 : 0;

  const handleCsvExport = useCallback(() => {
    exportStablecoinsCsv(sorted, pegScores, dexLiquidity, reportCards);
  }, [sorted, pegScores, dexLiquidity, reportCards]);

  if (isLoading) {
    return (
      <div className="pharos-card-shell overflow-hidden">
        <div className="bg-muted/50 h-10" />
        {SKELETON_ROWS.map((i) => (
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
    <div className="pharos-card-shell animate-in fade-in duration-300 overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border/60 bg-muted/22 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker sm:hidden">Swipe to reveal more metrics</p>
          <p className="text-xs text-muted-foreground sm:hidden">
            Name, price, and market cap stay readable first. Columns and export stay above the table.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <ColumnVisibilityDropdown
            visibleColumns={visibleColumns}
            setVisibleColumns={setVisibleColumns}
            resetColumns={resetColumns}
            defaultColumns={deviceDefault}
          />
          <Button
            variant="outline"
            size="sm"
            className="hidden sm:inline-flex border-border/70 sm:min-h-8 sm:w-auto"
            onClick={handleCsvExport}
            disabled={sorted.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Scroll container — handles both horizontal and vertical overflow */}
      <div ref={scrollRef} className="scroll-shadow max-h-[50vh] overflow-auto px-0 pb-3 pr-2 sm:max-h-[70vh] sm:pr-0">
        <table className="min-w-[420px] sm:min-w-[820px] w-full caption-bottom text-sm">
          <TableCaption className="sr-only">Stablecoin data table</TableCaption>
          <TableHeader className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
            <TableRow>
              {STABLECOIN_HEADER_DEFS.filter((column) => isVisible(column.id)).map((column) =>
                column.sortKey ? (
                  <SortableTableHead
                    key={column.id}
                    sortKey={column.sortKey}
                    currentSortKey={sortKey}
                    sortDirection={sortDirection}
                    label={typeof column.label === "string" ? column.label : ""}
                    toggleSort={toggleSort}
                    getAriaSortValue={getAriaSortValue}
                    handleSortKeyDown={handleSortKeyDown}
                    className={column.className}
                    title={column.title}
                  >
                    {column.label}
                  </SortableTableHead>
                ) : (
                  <TableHead key={column.id} scope="col" className={column.className} title={column.title}>
                    {column.label}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paddingTop > 0 && (
              <tr>
                <td style={{ height: paddingTop, padding: 0 }} />
              </tr>
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
                  className="group cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => router.push(buildStablecoinUrl(coin.id))}
                  onMouseEnter={() => prefetch(coin.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(buildStablecoinUrl(coin.id));
                    }
                  }}
                  role="link"
                  aria-label={`View ${coin.name} (${coin.symbol}) details`}
                  tabIndex={0}
                >
                  {isVisible("rank") && (
                    <TableCell className="text-right text-muted-foreground text-xs font-mono tabular-nums">
                      {index + 1}
                    </TableCell>
                  )}
                  {isVisible("name") && (
                    <TableCell>
                      <Link
                        href={buildStablecoinUrl(coin.id)}
                        className="pharos-focus-ring flex items-center gap-2 rounded-sm font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                        onMouseEnter={() => prefetch(coin.id)}
                      >
                        <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={24} />
                        <span className="font-medium">{coin.symbol}</span>
                        <span className="truncate max-w-[180px] text-xs text-muted-foreground hidden xl:inline">
                          {coin.name}
                        </span>
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
                        <span
                          className="text-muted-foreground"
                          title={
                            meta.flags.pegCurrency === "VAR"
                              ? "CPI-indexed, price tracks inflation"
                              : "NAV token, price appreciates with yield"
                          }
                        >
                          {meta.flags.pegCurrency === "VAR" ? "CPI" : "NAV"}
                        </span>
                      ) : (
                        (() => {
                          const ref = getPegReference(coin.pegType, pegRates, meta?.commodityOunces);
                          const price = coin.price;
                          const absBps =
                            price != null && typeof price === "number" && ref > 0
                              ? Math.abs(price / ref - 1) * 10_000
                              : null;
                          const colorClass = absBps === null ? "text-muted-foreground" : deviationColorClass(absBps);
                          return (
                            <span className={`inline-flex items-center gap-0.5 ${colorClass}`}>
                              {absBps !== null && <DeviationIcon absBps={absBps} />}
                              {formatPegDeviation(price, ref)}
                            </span>
                          );
                        })()
                      )}
                    </TableCell>
                  )}
                  {isVisible("mcap") && (
                    <TableCell className="text-right font-mono tabular-nums">{formatCurrency(circulating)}</TableCell>
                  )}
                  {isVisible("change24h") && (
                    <TableCell className="text-right font-mono tabular-nums text-sm">
                      <span
                        className={
                          change24h >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                        }
                      >
                        {prevDay > 0 ? (
                          <>
                            {change24h >= 0 ? "↑" : "↓"} {formatPercentChange(circulating, prevDay)}
                          </>
                        ) : (
                          "—"
                        )}
                      </span>
                    </TableCell>
                  )}
                  {isVisible("change7d") && (
                    <TableCell className="text-right font-mono tabular-nums text-sm">
                      <span
                        className={
                          change7d >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                        }
                      >
                        {prevWeek > 0 ? (
                          <>
                            <span className="hidden sm:inline">
                              <MiniSparkline
                                values={[getPrevWeekRaw(coin), getPrevDayRaw(coin), getCirculatingRaw(coin)]}
                              />
                            </span>
                            {change7d >= 0 ? "↑" : "↓"} {formatPercentChange(circulating, prevWeek)}
                          </>
                        ) : (
                          "—"
                        )}
                      </span>
                    </TableCell>
                  )}
                  {isVisible("grade") && (
                    <TableCell className="px-3 py-2 text-center">
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
                    <TableCell className="text-right font-mono tabular-nums text-sm">
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
                    <TableCell className="text-right font-mono tabular-nums text-sm">
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
                    <TableCell className="text-center">
                      {meta && (
                        <Badge variant="outline" className={`text-xs ${BACKING_COLORS[meta.flags.backing] ?? ""}`}>
                          {BACKING_LABELS_SHORT[meta.flags.backing]}
                        </Badge>
                      )}
                    </TableCell>
                  )}
                  {isVisible("type") && (
                    <TableCell className="text-center">
                      {meta && (
                        <Badge
                          variant="outline"
                          className={`text-xs ${GOVERNANCE_COLORS[meta.flags.governance] ?? ""}`}
                        >
                          {GOVERNANCE_LABELS_SHORT[meta.flags.governance]}
                        </Badge>
                      )}
                    </TableCell>
                  )}
                  {isVisible("flags") && (
                    <TableCell className="">
                      <div className="flex flex-wrap gap-1 justify-center">
                        {meta?.flags.pegCurrency !== "USD" && (
                          <Badge variant="secondary" className="text-xs">
                            {meta?.flags.pegCurrency}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td style={{ height: paddingBottom, padding: 0 }} />
              </tr>
            )}
            {sorted.length === 0 && (
              <TableRow>
                <TableCell colSpan={99} className="text-center text-muted-foreground py-12">
                  <p>{searchQuery ? `No results for "${searchQuery}"` : "No stablecoin data available"}</p>
                  {(searchQuery || activeFilters.length > 0) && (
                    <p className="mt-2 text-sm">
                      {searchQuery && onClearSearch && (
                        <button
                          onClick={onClearSearch}
                          className="pharos-focus-ring cursor-pointer rounded text-sm text-primary hover:underline"
                        >
                          Clear search
                        </button>
                      )}
                      {searchQuery && activeFilters.length > 0 && onClearSearch && onClearFilters && (
                        <span className="mx-1.5">or</span>
                      )}
                      {activeFilters.length > 0 && onClearFilters && (
                        <button
                          onClick={onClearFilters}
                          className="pharos-focus-ring cursor-pointer rounded text-sm text-primary hover:underline"
                        >
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
        <div
          className="flex items-center justify-between border-t border-border/60 px-4 py-2 text-sm text-muted-foreground"
          aria-label="Table pagination"
        >
          <span aria-live="polite">
            Showing {rangeStart}–{rangeEnd} of {sorted.length} stablecoins
          </span>
        </div>
      )}
    </div>
  );
}
