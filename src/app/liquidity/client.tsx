"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowUpDown, ArrowUp, ArrowDown, Search } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useLogos } from "@/hooks/use-logos";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { formatCurrency } from "@/lib/format";
import type { DexLiquidityData, PegCurrency } from "@/lib/types";

const PAGE_SIZE = 25;

type SortKey = "score" | "tvl" | "effectiveTvl" | "tvlTrend" | "volume" | "volume7d" | "vtRatio" | "pools" | "chains" | "balance" | "organic" | "durability";

interface SortConfig {
  key: SortKey;
  direction: "asc" | "desc";
}

const PEG_FILTERS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GOLD", label: "Gold" },
];

function SortIcon({ columnKey, sort }: { columnKey: string; sort: SortConfig }) {
  if (sort.key !== columnKey) return <ArrowUpDown className="ml-1 inline h-3.5 w-3.5 text-muted-foreground/50" />;
  return sort.direction === "asc" ? (
    <ArrowUp className="ml-1 inline h-3.5 w-3.5 text-foreground" />
  ) : (
    <ArrowDown className="ml-1 inline h-3.5 w-3.5 text-foreground" />
  );
}

function getScoreColor(score: number): string {
  if (score >= 80) return "text-emerald-500";
  if (score >= 60) return "text-blue-500";
  if (score >= 40) return "text-amber-500";
  return "text-red-500";
}

function BalanceBar({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const color = ratio >= 0.8 ? "bg-emerald-500" : ratio >= 0.5 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-10 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono tabular-nums text-xs w-7 text-right">{pct}%</span>
    </div>
  );
}

const CHAIN_COLORS: Record<string, string> = {
  Ethereum: "bg-blue-600",
  Arbitrum: "bg-sky-500",
  Base: "bg-blue-400",
  Polygon: "bg-violet-500",
  BSC: "bg-amber-500",
  Optimism: "bg-red-500",
  Avalanche: "bg-red-600",
  Solana: "bg-emerald-500",
  Gnosis: "bg-teal-500",
  Fantom: "bg-blue-300",
};

function ChainAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  const chainTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const liq of Object.values(data)) {
      for (const [chain, tvl] of Object.entries(liq.chainTvl)) {
        totals[chain] = (totals[chain] ?? 0) + tvl;
      }
    }
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [data]);

  const total = chainTotals.reduce((sum, [, v]) => sum + v, 0);
  if (total === 0) return null;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-sky-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Chain TVL Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted">
          {chainTotals.map(([chain, tvl]) => {
            const pct = (tvl / total) * 100;
            if (pct < 0.5) return null;
            return (
              <div
                key={chain}
                className={`${CHAIN_COLORS[chain] ?? "bg-muted-foreground"} transition-all`}
                style={{ width: `${pct}%` }}
                title={`${chain}: ${formatCurrency(tvl)} (${pct.toFixed(1)}%)`}
              />
            );
          })}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {chainTotals.slice(0, 10).map(([chain, tvl]) => (
            <div key={chain} className="flex items-center gap-2">
              <span className={`inline-block h-3 w-3 rounded-full ${CHAIN_COLORS[chain] ?? "bg-muted-foreground"}`} />
              <div>
                <p className="text-sm font-medium">{chain}</p>
                <p className="text-xs text-muted-foreground font-mono tabular-nums">{formatCurrency(tvl)}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const PROTOCOL_COLORS: Record<string, string> = {
  curve: "bg-blue-500",
  "uniswap-v3": "bg-pink-500",
  uniswap: "bg-pink-400",
  fluid: "bg-cyan-500",
  balancer: "bg-violet-500",
  aerodrome: "bg-sky-500",
  velodrome: "bg-red-500",
  pancakeswap: "bg-amber-500",
  sushiswap: "bg-indigo-500",
  "trader-joe": "bg-orange-500",
};

// Rotating palette for protocols without a hardcoded color
const EXTRA_COLORS = [
  "bg-emerald-500",
  "bg-lime-500",
  "bg-teal-500",
  "bg-rose-500",
  "bg-fuchsia-500",
  "bg-yellow-500",
  "bg-purple-500",
  "bg-orange-400",
];

const PROTOCOL_NAMES: Record<string, string> = {
  curve: "Curve",
  "uniswap-v3": "Uniswap V3",
  uniswap: "Uniswap",
  fluid: "Fluid",
  balancer: "Balancer",
  aerodrome: "Aerodrome",
  velodrome: "Velodrome",
  pancakeswap: "PancakeSwap",
  sushiswap: "SushiSwap",
  "trader-joe": "Trader Joe",
};

/** Prettify a DeFiLlama project slug into a display name */
function prettifyProtocol(slug: string): string {
  if (PROTOCOL_NAMES[slug]) return PROTOCOL_NAMES[slug];
  return slug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const MAX_VISIBLE_PROTOCOLS = 10;

function ProtocolAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  // Aggregate protocol TVL across all stablecoins
  const { displayEntries, colorMap, total } = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const liq of Object.values(data)) {
      for (const [protocol, tvl] of Object.entries(liq.protocolTvl)) {
        totals[protocol] = (totals[protocol] ?? 0) + tvl;
      }
    }
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]) as [string, number][];
    const t = sorted.reduce((sum, [, v]) => sum + v, 0);

    // Top N protocols shown individually, rest grouped into "Other"
    const visible = sorted.slice(0, MAX_VISIBLE_PROTOCOLS);
    const otherTvl = sorted
      .slice(MAX_VISIBLE_PROTOCOLS)
      .reduce((sum, [, v]) => sum + v, 0);
    const entries: [string, number][] = otherTvl > 0
      ? [...visible, ["_other", otherTvl]]
      : visible;

    // Pre-compute colors: hardcoded for known, rotating palette for the rest
    const map: Record<string, string> = { _other: "bg-muted-foreground" };
    let idx = 0;
    for (const [protocol] of entries) {
      if (protocol === "_other") continue;
      map[protocol] = PROTOCOL_COLORS[protocol] ?? EXTRA_COLORS[idx++ % EXTRA_COLORS.length];
    }

    return { displayEntries: entries, colorMap: map, total: t };
  }, [data]);

  if (total === 0) return null;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Protocol TVL Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted">
          {displayEntries.map(([protocol, tvl]) => {
            const pct = (tvl / total) * 100;
            if (pct < 0.5) return null;
            const color = colorMap[protocol] ?? "bg-muted-foreground";
            const name = protocol === "_other" ? "Other" : prettifyProtocol(protocol);
            return (
              <div
                key={protocol}
                className={`${color} transition-all`}
                style={{ width: `${pct}%` }}
                title={`${name}: ${formatCurrency(tvl)} (${pct.toFixed(1)}%)`}
              />
            );
          })}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {displayEntries.map(([protocol, tvl]) => {
            const color = colorMap[protocol] ?? "bg-muted-foreground";
            const name = protocol === "_other" ? "Other" : prettifyProtocol(protocol);
            return (
              <div key={protocol} className="flex items-center gap-2">
                <span className={`inline-block h-3 w-3 rounded-full ${color}`} />
                <div>
                  <p className="text-sm font-medium">{name}</p>
                  <p className="text-xs text-muted-foreground font-mono tabular-nums">{formatCurrency(tvl)}</p>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function LiquidityClient() {
  const { data: liquidityMap, isLoading } = useDexLiquidity();
  const { data: logos } = useLogos();
  const [sort, setSort] = useState<SortConfig>({ key: "score", direction: "desc" });
  const [page, setPage] = useState(0);
  const [pegFilter, setPegFilter] = useState<PegCurrency | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const router = useRouter();

  // Combine tracked stablecoins with liquidity data
  const rows = useMemo(() => {
    if (!liquidityMap) return [];
    const q = searchQuery.toLowerCase().trim();
    return TRACKED_STABLECOINS
      .filter((meta) => {
        if (pegFilter !== "all" && meta.flags.pegCurrency !== pegFilter) return false;
        if (q && !meta.name.toLowerCase().includes(q) && !meta.symbol.toLowerCase().includes(q)) return false;
        return true;
      })
      .map((meta) => ({
        meta,
        liq: liquidityMap[meta.id] as DexLiquidityData | undefined,
      }))
      .filter((r) => r.liq && (r.liq.liquidityScore ?? 0) > 0);
  }, [liquidityMap, pegFilter, searchQuery]);

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aLiq = a.liq!;
      const bLiq = b.liq!;
      let aVal: number, bVal: number;
      switch (sort.key) {
        case "score":
          aVal = aLiq.liquidityScore ?? 0;
          bVal = bLiq.liquidityScore ?? 0;
          break;
        case "tvl":
          aVal = aLiq.totalTvlUsd;
          bVal = bLiq.totalTvlUsd;
          break;
        case "tvlTrend":
          aVal = aLiq.tvlChange7d ?? 0;
          bVal = bLiq.tvlChange7d ?? 0;
          break;
        case "volume":
          aVal = aLiq.totalVolume24hUsd;
          bVal = bLiq.totalVolume24hUsd;
          break;
        case "volume7d":
          aVal = aLiq.totalVolume7dUsd;
          bVal = bLiq.totalVolume7dUsd;
          break;
        case "vtRatio":
          aVal = aLiq.totalTvlUsd > 0 ? aLiq.totalVolume24hUsd / aLiq.totalTvlUsd : 0;
          bVal = bLiq.totalTvlUsd > 0 ? bLiq.totalVolume24hUsd / bLiq.totalTvlUsd : 0;
          break;
        case "pools":
          aVal = aLiq.poolCount;
          bVal = bLiq.poolCount;
          break;
        case "chains":
          aVal = aLiq.chainCount;
          bVal = bLiq.chainCount;
          break;
        case "effectiveTvl":
          aVal = aLiq.effectiveTvlUsd ?? 0;
          bVal = bLiq.effectiveTvlUsd ?? 0;
          break;
        case "balance":
          aVal = aLiq.weightedBalanceRatio ?? 0;
          bVal = bLiq.weightedBalanceRatio ?? 0;
          break;
        case "organic":
          aVal = aLiq.organicFraction ?? 0;
          bVal = bLiq.organicFraction ?? 0;
          break;
        case "durability":
          aVal = aLiq.durabilityScore ?? 0;
          bVal = bLiq.durabilityScore ?? 0;
          break;
        default:
          aVal = aLiq.liquidityScore ?? 0;
          bVal = bLiq.liquidityScore ?? 0;
      }
      return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [rows, sort]);

  // Reset page when filter/search changes
  const [prevFilter, setPrevFilter] = useState(pegFilter);
  const [prevSearch, setPrevSearch] = useState(searchQuery);
  if (prevFilter !== pegFilter || prevSearch !== searchQuery) {
    setPrevFilter(pegFilter);
    setPrevSearch(searchQuery);
    setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "desc" }
    );
  }

  function getAriaSortValue(columnKey: string): "ascending" | "descending" | "none" {
    if (sort.key !== columnKey) return "none";
    return sort.direction === "asc" ? "ascending" : "descending";
  }

  function handleSortKeyDown(e: React.KeyboardEvent, key: SortKey) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleSort(key);
    }
  }

  // Summary stats
  const summaryStats = useMemo(() => {
    if (!liquidityMap) return null;
    let totalTvl = 0;
    let totalVol = 0;
    let scoreSum = 0;
    let scoreCount = 0;
    let withLiquidity = 0;
    let tvlChangeWeighted = 0;
    let tvlChangeCount = 0;
    let totalBalance = 0;
    let balanceWeight = 0;
    let totalOrganic = 0;
    let organicWeight = 0;

    for (const meta of TRACKED_STABLECOINS) {
      const liq = liquidityMap[meta.id];
      if (!liq) continue;
      totalTvl += liq.totalTvlUsd;
      totalVol += liq.totalVolume24hUsd;
      if (liq.liquidityScore != null && liq.liquidityScore > 0) {
        scoreSum += liq.liquidityScore;
        scoreCount++;
        withLiquidity++;
      }
      if (liq.tvlChange7d != null && liq.totalTvlUsd > 0) {
        // Weight the % change by TVL to get aggregate trend
        const prevTvl = liq.totalTvlUsd / (1 + liq.tvlChange7d / 100);
        tvlChangeWeighted += prevTvl;
        tvlChangeCount++;
      }
      if (liq.weightedBalanceRatio != null) {
        totalBalance += liq.weightedBalanceRatio * liq.totalTvlUsd;
        balanceWeight += liq.totalTvlUsd;
      }
      if (liq.organicFraction != null) {
        totalOrganic += liq.organicFraction * liq.totalTvlUsd;
        organicWeight += liq.totalTvlUsd;
      }
    }

    // Compute aggregate 7d change from TVL-weighted average
    const totalPrevTvl = tvlChangeCount > 0 ? tvlChangeWeighted : 0;
    const agg7dChange = totalPrevTvl > 0 ? ((totalTvl - totalPrevTvl) / totalPrevTvl) * 100 : null;

    return {
      totalTvl,
      totalVol,
      avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 0,
      withLiquidity,
      agg7dChange: agg7dChange != null ? Math.round(agg7dChange * 10) / 10 : null,
      avgBalance: balanceWeight > 0 ? Math.round((totalBalance / balanceWeight) * 100) : null,
      avgOrganic: organicWeight > 0 ? Math.round((totalOrganic / organicWeight) * 100) : null,
    };
  }, [liquidityMap]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="rounded-2xl">
              <CardHeader className="pb-1"><Skeleton className="h-3 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-8 w-32" /></CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Card className="rounded-2xl border-l-[3px] border-l-blue-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total DEX TVL</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono tracking-tight">{formatCurrency(summaryStats?.totalTvl ?? 0)}</div>
            <p className="text-sm text-muted-foreground">
              Across all tracked stablecoins
              {summaryStats?.agg7dChange != null && (
                <span className={`ml-2 font-mono ${summaryStats.agg7dChange >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {summaryStats.agg7dChange >= 0 ? "\u2191" : "\u2193"}{Math.abs(summaryStats.agg7dChange).toFixed(1)}% 7d
                </span>
              )}
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-l-[3px] border-l-emerald-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">24h DEX Volume</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono tracking-tight">{formatCurrency(summaryStats?.totalVol ?? 0)}</div>
            <p className="text-sm text-muted-foreground">Trading volume today</p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-l-[3px] border-l-amber-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Avg Liq Score</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-3xl font-bold font-mono tracking-tight ${getScoreColor(summaryStats?.avgScore ?? 0)}`}>
              {summaryStats?.avgScore ?? 0}<span className="text-lg text-muted-foreground">/100</span>
            </div>
            <p className="text-sm text-muted-foreground">Mean score of active coins</p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Active on DEX</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono tracking-tight">{summaryStats?.withLiquidity ?? 0}</div>
            <p className="text-sm text-muted-foreground">of {TRACKED_STABLECOINS.length} tracked stablecoins</p>
          </CardContent>
        </Card>
        {summaryStats?.avgBalance != null && (
          <Card className="rounded-2xl border-l-[3px] border-l-cyan-500">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Avg Pool Balance</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono tracking-tight">{summaryStats.avgBalance}%</div>
              <p className="text-sm text-muted-foreground">TVL-weighted average</p>
            </CardContent>
          </Card>
        )}
        {summaryStats?.avgOrganic != null && (
          <Card className="rounded-2xl border-l-[3px] border-l-pink-500">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Organic Liquidity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono tracking-tight">{summaryStats.avgOrganic}%</div>
              <p className="text-sm text-muted-foreground">Fee-based vs incentivized</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Protocol TVL Breakdown */}
      {liquidityMap && <ProtocolAggregateBar data={liquidityMap} />}

      {/* Chain TVL Breakdown */}
      {liquidityMap && <ChainAggregateBar data={liquidityMap} />}

      {/* Filters + Leaderboard */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Liquidity Leaderboard</h2>
          <div className="flex items-center gap-3">
            <ToggleGroup
              type="single"
              value={pegFilter}
              onValueChange={(v) => v && setPegFilter(v as PegCurrency | "all")}
              className="flex gap-1"
            >
              {PEG_FILTERS.map((f) => (
                <ToggleGroupItem key={f.value} value={f.value} variant="outline" size="sm" className="text-xs">
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="relative w-full sm:w-44">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-xs"
                aria-label="Search stablecoins by name or symbol"
              />
            </div>
          </div>
        </div>

        <div className="rounded-xl border overflow-x-auto table-striped scroll-shadow">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[50px] text-right">#</TableHead>
                <TableHead className="w-[200px]">Name</TableHead>
                <TableHead
                  className="cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("score")}
                  aria-sort={getAriaSortValue("score")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "score")}
                >
                  Score <SortIcon columnKey="score" sort={sort} />
                </TableHead>
                <TableHead
                  className="cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("tvl")}
                  aria-sort={getAriaSortValue("tvl")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "tvl")}
                >
                  DEX TVL <SortIcon columnKey="tvl" sort={sort} />
                </TableHead>
                <TableHead
                  className="hidden lg:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("tvlTrend")}
                  aria-sort={getAriaSortValue("tvlTrend")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "tvlTrend")}
                >
                  7d Trend <SortIcon columnKey="tvlTrend" sort={sort} />
                </TableHead>
                <TableHead
                  className="cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("volume")}
                  aria-sort={getAriaSortValue("volume")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "volume")}
                >
                  24h Vol <SortIcon columnKey="volume" sort={sort} />
                </TableHead>
                <TableHead
                  className="hidden lg:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("volume7d")}
                  aria-sort={getAriaSortValue("volume7d")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "volume7d")}
                >
                  7d Vol <SortIcon columnKey="volume7d" sort={sort} />
                </TableHead>
                <TableHead
                  className="hidden sm:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("vtRatio")}
                  aria-sort={getAriaSortValue("vtRatio")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "vtRatio")}
                >
                  Vol/TVL <SortIcon columnKey="vtRatio" sort={sort} />
                </TableHead>
                <TableHead
                  className="hidden sm:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("pools")}
                  aria-sort={getAriaSortValue("pools")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "pools")}
                >
                  Pools <SortIcon columnKey="pools" sort={sort} />
                </TableHead>
                <TableHead
                  className="hidden sm:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("chains")}
                  aria-sort={getAriaSortValue("chains")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "chains")}
                >
                  Chains <SortIcon columnKey="chains" sort={sort} />
                </TableHead>
                <TableHead className="hidden md:table-cell text-left">Top Protocol</TableHead>
                <TableHead
                  className="hidden xl:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("effectiveTvl")}
                  aria-sort={getAriaSortValue("effectiveTvl")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "effectiveTvl")}
                >
                  Eff. TVL <SortIcon columnKey="effectiveTvl" sort={sort} />
                </TableHead>
                <TableHead
                  className="hidden xl:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("balance")}
                  aria-sort={getAriaSortValue("balance")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "balance")}
                >
                  Balance <SortIcon columnKey="balance" sort={sort} />
                </TableHead>
                <TableHead
                  className="hidden xl:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("organic")}
                  aria-sort={getAriaSortValue("organic")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "organic")}
                >
                  Organic <SortIcon columnKey="organic" sort={sort} />
                </TableHead>
                <TableHead
                  className="hidden xl:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort("durability")}
                  aria-sort={getAriaSortValue("durability")}
                  tabIndex={0}
                  onKeyDown={(e) => handleSortKeyDown(e, "durability")}
                >
                  Durability <SortIcon columnKey="durability" sort={sort} />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginated.map((row, index) => {
                const liq = row.liq!;
                const vtRatio = liq.totalTvlUsd > 0 ? liq.totalVolume24hUsd / liq.totalTvlUsd : 0;
                const topProtocol = Object.entries(liq.protocolTvl).sort((a, b) => b[1] - a[1])[0];

                return (
                  <TableRow
                    key={row.meta.id}
                    className="hover:bg-muted/70 cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                    onClick={() => router.push(`/stablecoin/${row.meta.id}`)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(`/stablecoin/${row.meta.id}`); } }}
                    tabIndex={0}
                  >
                    <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                      {page * PAGE_SIZE + index + 1}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <StablecoinLogo src={logos?.[row.meta.id]} name={row.meta.name} size={24} />
                        <span className="font-medium truncate max-w-[140px]">{row.meta.name}</span>
                        <span className="text-xs text-muted-foreground">{row.meta.symbol}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      <span className={getScoreColor(liq.liquidityScore ?? 0)}>
                        {liq.liquidityScore ?? 0}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatCurrency(liq.totalTvlUsd)}</TableCell>
                    <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums text-sm">
                      {liq.tvlChange7d != null ? (
                        <span className={liq.tvlChange7d >= 0 ? "text-emerald-500" : "text-red-500"}>
                          {liq.tvlChange7d >= 0 ? "\u2191" : "\u2193"}{Math.abs(liq.tvlChange7d).toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatCurrency(liq.totalVolume24hUsd)}</TableCell>
                    <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums">{formatCurrency(liq.totalVolume7dUsd)}</TableCell>
                    <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums text-sm">
                      {(vtRatio * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums">{liq.poolCount}</TableCell>
                    <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums">{liq.chainCount}</TableCell>
                    <TableCell className="hidden md:table-cell text-left text-sm text-muted-foreground">
                      {topProtocol ? prettifyProtocol(topProtocol[0]) : "—"}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-right font-mono tabular-nums">
                      {liq.effectiveTvlUsd ? formatCurrency(liq.effectiveTvlUsd) : "—"}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-right">
                      {liq.weightedBalanceRatio != null ? (
                        <BalanceBar ratio={liq.weightedBalanceRatio} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-right font-mono tabular-nums">
                      {liq.organicFraction != null ? `${Math.round(liq.organicFraction * 100)}%` : "—"}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-right">
                      {liq.durabilityScore != null ? (
                        <span className={`font-mono tabular-nums ${
                          liq.durabilityScore >= 70 ? "text-emerald-500" :
                          liq.durabilityScore >= 40 ? "text-amber-500" : "text-red-500"
                        }`}>{liq.durabilityScore}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {sorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={99} className="text-center text-muted-foreground py-8">
                    {searchQuery ? `No results for "${searchQuery}"` : "No liquidity data available"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {sorted.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <span className="text-sm text-muted-foreground" aria-live="polite">
                Showing {sorted.length === 0 ? 0 : page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
