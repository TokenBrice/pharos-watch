"use client";

import { useMemo } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useChains } from "@/hooks/use-chains";
import { useSort } from "@/hooks/use-sort";
import { Card, CardContent } from "@/components/ui/card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead } from "@/components/sortable-table-head";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatChainUsd, formatRatioPct, HEALTH_BADGE_CLASSES, trendColor } from "@/lib/chain-ui";
import { CHAIN_META } from "@shared/lib/chains";
import type { HealthBand, ChainSummary } from "@shared/types/chains";

type ChainSortKey = "totalUsd" | "healthScore" | "change24hPct" | "change7dPct" | "change30dPct" | "stablecoinCount" | "dominanceShare";

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="px-4 py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-bold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}

function HealthBadge({ score, band }: { score: number | null; band: HealthBand | null }) {
  if (score == null || band == null) {
    return <span className="text-xs text-muted-foreground">--</span>;
  }
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", HEALTH_BADGE_CLASSES[band])}>
      {score}
      <span className="hidden sm:inline capitalize">{band}</span>
    </span>
  );
}

function sortChains(chains: ChainSummary[], key: ChainSortKey, dir: "asc" | "desc"): ChainSummary[] {
  return [...chains].sort((a, b) => {
    const av = a[key] ?? -Infinity;
    const bv = b[key] ?? -Infinity;
    return dir === "desc" ? (bv as number) - (av as number) : (av as number) - (bv as number);
  });
}

export function ChainsLeaderboardClient() {
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useChains();
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } = useSort<ChainSortKey>("totalUsd", "desc");
  const router = useRouter();

  const sorted = useMemo(() => {
    if (!data?.chains) return [];
    return sortChains(data.chains, sortKey, sortDirection);
  }, [data, sortKey, sortDirection]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
        <div className="rounded-lg border">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="mx-3 my-2.5 h-8 rounded" />
          ))}
        </div>
      </div>
    );
  }
  if (isError && !data) {
    return (
      <QueryErrorNotice error={error} onRetry={() => { void refetch(); }} />
    );
  }
  if (!data) return null;

  const topHealthChain = [...data.chains].sort((a, b) => (b.healthScore ?? -1) - (a.healthScore ?? -1))[0];
  const topSupplyChain = [...data.chains].sort((a, b) => b.totalUsd - a.totalUsd)[0];

  return (
    <div className="space-y-6">
      <QueryErrorNotice error={error} hasData={!!data?.chains?.length} onRetry={() => { void refetch(); }} />
      <StaleDataBanner queries={[{ preset: "chains", dataUpdatedAt, error, hasData: !!data?.chains?.length }]} />
      {/* KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Stablecoin Supply" value={formatChainUsd(data.globalTotalUsd)} />
        <KpiCard label="Active Chains" value={String(data.chains.length)} />
        <KpiCard label="Top Chain" value={topSupplyChain ? `${topSupplyChain.name} ${(topSupplyChain.dominanceShare * 100).toFixed(1)}%` : "--"} />
        <KpiCard label="Healthiest Chain" value={topHealthChain?.healthScore != null ? `${topHealthChain.name} (${topHealthChain.healthScore})` : "--"} />
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <caption className="sr-only">Blockchain networks ranked by stablecoin supply</caption>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-[50px] text-right">#</TableHead>
              <TableHead>Chain</TableHead>
              <SortableTableHead<ChainSortKey>
                sortKey="healthScore"
                currentSortKey={sortKey}
                sortDirection={sortDirection}
                label="Health"
                toggleSort={toggleSort}
                getAriaSortValue={getAriaSortValue}
                handleSortKeyDown={handleSortKeyDown}
                title="Composite chain health score"
              />
              <SortableTableHead<ChainSortKey>
                sortKey="totalUsd"
                currentSortKey={sortKey}
                sortDirection={sortDirection}
                label="Supply"
                toggleSort={toggleSort}
                getAriaSortValue={getAriaSortValue}
                handleSortKeyDown={handleSortKeyDown}
                className="text-right"
              />
              <SortableTableHead<ChainSortKey>
                sortKey="change7dPct"
                currentSortKey={sortKey}
                sortDirection={sortDirection}
                label="7d"
                toggleSort={toggleSort}
                getAriaSortValue={getAriaSortValue}
                handleSortKeyDown={handleSortKeyDown}
                className="text-right"
                title="7-day supply change"
              />
              <SortableTableHead<ChainSortKey>
                sortKey="dominanceShare"
                currentSortKey={sortKey}
                sortDirection={sortDirection}
                label="Global Share"
                toggleSort={toggleSort}
                getAriaSortValue={getAriaSortValue}
                handleSortKeyDown={handleSortKeyDown}
                className="text-right"
              />
              <SortableTableHead<ChainSortKey>
                sortKey="stablecoinCount"
                currentSortKey={sortKey}
                sortDirection={sortDirection}
                label="Stablecoins"
                toggleSort={toggleSort}
                getAriaSortValue={getAriaSortValue}
                handleSortKeyDown={handleSortKeyDown}
                className="text-right"
              />
              <TableHead className="hidden lg:table-cell">Dominant</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((chain, i) => (
              <TableRow
                key={chain.id}
                className="group cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                onClick={() => router.push(`/chains/${chain.id}/`)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    router.push(`/chains/${chain.id}/`);
                  }
                }}
              >
                <TableCell className="text-right text-muted-foreground tabular-nums">{i + 1}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Image src={chain.logoPath} alt="" width={20} height={20} className={`rounded-full${CHAIN_META[chain.id]?.darkInvert ? " dark:invert" : ""}`} />
                    <span className="font-medium">{chain.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">{chain.type}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <HealthBadge score={chain.healthScore} band={chain.healthBand} />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatChainUsd(chain.totalUsd)}</TableCell>
                <TableCell className={cn("text-right font-mono tabular-nums", trendColor(chain.change7dPct))}>
                  {formatRatioPct(chain.change7dPct)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary/60" style={{ width: `${Math.min(100, chain.dominanceShare * 100)}%` }} />
                    </div>
                    <span className="text-xs font-mono tabular-nums text-muted-foreground w-10 text-right">{(chain.dominanceShare * 100).toFixed(1)}%</span>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{chain.stablecoinCount}</TableCell>
                <TableCell className="hidden lg:table-cell text-sm">
                  {chain.dominantStablecoin.symbol} ({(chain.dominantStablecoin.share * 100).toFixed(0)}%)
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </table>
      </div>
    </div>
  );
}
