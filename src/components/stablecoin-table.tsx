"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNativePrice, formatPegDeviation, formatPercentChange } from "@/lib/format";
import { getPegReference } from "@/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@/lib/supply";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID, TRACKED_IDS } from "@/lib/stablecoins";
import type { StablecoinData, FilterTag, PegSummaryCoin, BluechipRating, DexLiquidityMap, ReportCard } from "@/lib/types";
import { getFilterTags, OTHER_PEG_TAGS } from "@/lib/types";
import { GRADE_COLORS, BACKING_COLORS, GOVERNANCE_COLORS, BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT } from "@/lib/classification";
import { REPORT_CARD_GRADE_COLORS } from "@/lib/report-cards";
import { deviationColorClass, getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SortableTableHead } from "@/components/sortable-table-head";
import { TablePagination } from "@/components/table-pagination";
import { useSort } from "@/hooks/use-sort";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";

const PAGE_SIZE = 25;

interface StablecoinTableProps {
  data: StablecoinData[] | undefined;
  isLoading: boolean;
  activeFilters: FilterTag[];
  logos?: Record<string, string>;
  pegRates?: Record<string, number>;
  searchQuery?: string;
  pegScores?: Map<string, PegSummaryCoin>;
  bluechipRatings?: Record<string, BluechipRating>;
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


export function StablecoinTable({ data, isLoading, activeFilters, logos, pegRates = {}, searchQuery, pegScores, bluechipRatings, dexLiquidity, reportCards, onClearSearch, onClearFilters }: StablecoinTableProps) {
  type SortKey = "name" | "price" | "mcap" | "change24h" | "change7d" | "stability" | "liquidity" | "grade";
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } = useSort<SortKey>("mcap", "desc");
  const sort = useMemo(() => ({ key: sortKey, direction: sortDirection }), [sortKey, sortDirection]);
  const [page, setPage] = useState(0);
  const router = useRouter();
  const prefetch = usePrefetchStablecoin();
  const metaById = TRACKED_META_BY_ID;

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
    return [...filtered].sort((a, b) => {
      let aVal: number, bVal: number;
      switch (sort.key) {
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
          // NAV tokens / null scores sort last regardless of direction
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
  }, [filtered, sort, pegScores, dexLiquidity, reportCards]);

  // Reset page when filters, search, or sort change (adjusting state during render)
  const [prev, setPrev] = useState({ filtered, sort });
  if (prev.filtered !== filtered || prev.sort !== sort) {
    setPrev({ filtered, sort });
    setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rangeStart = sorted.length === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, sorted.length);


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
    <div className="rounded-xl border overflow-x-auto table-striped scroll-shadow animate-in fade-in duration-300">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="w-[50px] text-right">#</TableHead>
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
            <TableHead className="text-right">Peg</TableHead>
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
            <SortableTableHead
              sortKey="change24h"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="24h"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="change7d"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="7d"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden sm:table-cell text-right"
            />
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
            <SortableTableHead
              sortKey="stability"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Peg Score"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden sm:table-cell text-right"
            />
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
            <TableHead className="hidden md:table-cell text-center">Backing</TableHead>
            <TableHead className="hidden md:table-cell text-center">Type</TableHead>
            <TableHead className="hidden md:table-cell text-center">Flags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.map((coin, index) => {
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
                onClick={() => router.push(`/stablecoin/${coin.id}`)}
                onMouseEnter={() => prefetch(coin.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(`/stablecoin/${coin.id}`); } }}
                tabIndex={0}
              >
                <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                  {page * PAGE_SIZE + index + 1}
                </TableCell>
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
                    {(() => {
                      const rating = bluechipRatings?.[coin.id];
                      if (!rating) return null;
                      const colorCls = GRADE_COLORS[rating.grade] ?? "";
                      return (
                        <Badge variant="outline" className={`text-xs font-mono px-1 py-0 hidden sm:inline-flex ${colorCls}`} title={`Bluechip safety rating: ${rating.grade}`}>
                          {rating.grade}
                        </Badge>
                      );
                    })()}
                  </Link>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {(() => {
                    const ref = getPegReference(coin.pegType, pegRates, meta?.commodityOunces);
                    return formatNativePrice(coin.price, meta?.flags.pegCurrency ?? "USD", ref);
                  })()}
                </TableCell>
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
                <TableCell className="text-right font-mono tabular-nums">{formatCurrency(circulating)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm">
                  <span className={change24h >= 0 ? "text-green-500" : "text-red-500"}>
                    {prevDay > 0 ? (
                      <>{change24h >= 0 ? "↑" : "↓"} {formatPercentChange(circulating, prevDay)}</>
                    ) : "N/A"}
                  </span>
                </TableCell>
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
                <TableCell className="hidden md:table-cell text-center">
                  {meta && (
                    <Badge variant="outline" className={`text-xs ${BACKING_COLORS[meta.flags.backing] ?? ""}`}>
                      {BACKING_LABELS_SHORT[meta.flags.backing]}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="hidden md:table-cell text-center">
                  {meta && (
                    <Badge variant="outline" className={`text-xs ${GOVERNANCE_COLORS[meta.flags.governance] ?? ""}`}>
                      {GOVERNANCE_LABELS_SHORT[meta.flags.governance]}
                    </Badge>
                  )}
                </TableCell>
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
              </TableRow>
            );
          })}
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
      </Table>
      {sorted.length > 0 && (
        <TablePagination
          page={page}
          totalPages={totalPages}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          total={sorted.length}
          onPrevious={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
        />
      )}
    </div>
  );
}
