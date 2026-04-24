"use client";

import { useMemo } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useChains } from "@/hooks/use-chains";
import { useSort } from "@/hooks/use-sort";
import { TableCell } from "@/components/ui/table";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { HEALTH_BADGE_CLASSES, trendColor } from "@/lib/chain-ui";
import { formatSignedPercent } from "@shared/lib/format";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { CHAIN_META } from "@shared/lib/chains";
import { formatCompactUsd } from "@shared/lib/format";
import type { HealthBand, ChainSummary } from "@shared/types/chains";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { logosById } from "@/lib/logos";
import { NauticalChart } from "./nautical-chart";

/** Muted oklch palette for the dominance breakdown bar — distinct but not decorative. */
const DOMINANCE_COLORS = [
  "oklch(0.62 0.14 250)", // blue
  "oklch(0.58 0.14 300)", // violet
  "oklch(0.70 0.13 80)",  // amber
  "oklch(0.62 0.14 160)", // teal
  "oklch(0.62 0.12 20)",  // rose
];

type ChainSortKey = "totalUsd" | "healthScore" | "change24hPct" | "change7dPct" | "change30dPct" | "stablecoinCount" | "dominanceShare";
const CHAIN_COLUMNS: readonly DataTableColumn<ChainSortKey>[] = [
  { id: "rank", label: "#", className: "w-[40px] text-right" },
  { id: "chain", label: "Chain" },
  { id: "health", label: "Health", sortKey: "healthScore" },
  { id: "supply", label: "Supply", sortKey: "totalUsd", className: "text-right" },
  { id: "change7d", label: "7d", sortKey: "change7dPct", className: "text-right", title: "7-day supply change" },
  { id: "globalShare", label: "Global Share", sortKey: "dominanceShare", className: "text-right" },
  { id: "stablecoins", label: "Stablecoins", sortKey: "stablecoinCount", className: "text-right" },
  { id: "dominant", label: "Dominant", className: "hidden lg:table-cell" },
] as const;

function HealthBadge({ score, band }: { score: number | null; band: HealthBand | null }) {
  if (score == null || band == null) {
    return <span className="text-xs text-muted-foreground">--</span>;
  }
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", HEALTH_BADGE_CLASSES[band])} title={`${score} — ${band}`}>
      {score}
      <span className="hidden sm:inline capitalize">{band}</span>
    </span>
  );
}


function sortChains(chains: ChainSummary[], key: ChainSortKey, dir: "asc" | "desc"): ChainSummary[] {
  return [...chains].sort((a, b) => {
    const av = a[key] ?? -Infinity;
    const bv = b[key] ?? -Infinity;
    return dir === "desc" ? bv - av : av - bv;
  });
}

export function ChainsLeaderboardClient() {
  const { data, isLoading, isError, error, refetch, dataUpdatedAt, meta } = useChains();
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } = useSort<ChainSortKey>("totalUsd", "desc");
  const router = useRouter();

  const sorted = useMemo(() => {
    if (!data?.chains) return [];
    return sortChains(data.chains, sortKey, sortDirection);
  }, [data, sortKey, sortDirection]);

  // Top chains by supply for dominance breakdown (independent of table sort)
  const topBySupply = useMemo(() => {
    if (!data?.chains) return [];
    return [...data.chains].sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 5);
  }, [data]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="pharos-subtle-band space-y-3 py-4">
          <div className="flex items-end justify-between gap-4">
            <div>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-9 w-44" />
            </div>
            <div className="flex gap-4">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-12" />
            </div>
          </div>
          <Skeleton className="h-2.5 w-full rounded-full" />
          <div className="flex gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-20" />
            ))}
          </div>
        </div>
        <div className="pharos-table-shell">
          {Array.from({ length: 10 }).map((_, i) => (
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

  // Aggregate 7d change for global trend
  const globalChange7d = data.globalTotalUsd > 0
    ? data.chains.reduce((sum, c) => sum + (c.change7dPct || 0) * c.totalUsd, 0) / data.globalTotalUsd
    : 0;
  const change7dPct = globalChange7d * 100;
  const show7dTrend = Math.abs(change7dPct) >= 0.05;

  return (
    <SectionErrorBoundary name="Chains">
    <div className="space-y-4">
      <QueryErrorNotice error={error} hasData={!!data?.chains?.length} onRetry={() => { void refetch(); }} />
      <StaleDataBanner queries={[{ preset: "chains", dataUpdatedAt, error, hasData: !!data?.chains?.length, meta }]} />

      {/* Hero summary */}
      <div className="pharos-subtle-band space-y-3 py-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <p className="pharos-kicker">Total Stablecoin Supply</p>
            <p className="mt-1 text-3xl font-extrabold font-mono tabular-nums tracking-tight">
              {formatCompactUsd(data.globalTotalUsd)}
            </p>
          </div>
          <div className="flex items-center gap-5 pb-1 text-sm">
            {show7dTrend && (
              <span>
                <span className="pharos-kicker mr-1.5">7d</span>
                <span className={cn("font-mono font-semibold tabular-nums", change7dPct > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                  {change7dPct >= 0 ? "+" : ""}{change7dPct.toFixed(1)}%
                </span>
              </span>
            )}
            <span>
              <span className="pharos-kicker mr-1.5">Chains</span>
              <span className="font-mono font-semibold tabular-nums">{data.chains.length}</span>
            </span>
          </div>
        </div>

        {/* Dominance breakdown */}
        {topBySupply.length > 0 && (() => {
          const othersShare = 1 - topBySupply.reduce((s, c) => s + c.dominanceShare, 0);
          return (
            <>
              <div
                className="flex h-2.5 w-full overflow-hidden rounded-full"
                role="img"
                aria-label={`Supply dominance: ${topBySupply.map((c) => `${c.name} ${(c.dominanceShare * 100).toFixed(1)}%`).join(", ")}${othersShare > 0.005 ? `, Others ${(othersShare * 100).toFixed(1)}%` : ""}`}
              >
                {topBySupply.map((chain, idx) => (
                  <div
                    key={chain.id}
                    className="h-full transition-all duration-500"
                    style={{
                      width: `${chain.dominanceShare * 100}%`,
                      backgroundColor: DOMINANCE_COLORS[idx],
                    }}
                  />
                ))}
                {othersShare > 0.005 && (
                  <div
                    className="h-full bg-muted-foreground/20"
                    style={{ width: `${othersShare * 100}%` }}
                  />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {topBySupply.map((chain, idx) => (
                  <span key={chain.id} className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: DOMINANCE_COLORS[idx] }}
                    />
                    <Image
                      src={chain.logoPath}
                      alt=""
                      width={14}
                      height={14}
                      className={cn("rounded-full", CHAIN_META[chain.id]?.darkInvert ? "dark:invert" : "")}
                      style={{ width: 14, height: 14 }}
                    />
                    <span>{chain.name}</span>
                    <span className="font-mono tabular-nums">{(chain.dominanceShare * 100).toFixed(1)}%</span>
                  </span>
                ))}
                {othersShare > 0.005 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/20" />
                    <span>Others</span>
                    <span className="font-mono tabular-nums">{(othersShare * 100).toFixed(1)}%</span>
                  </span>
                )}
              </div>
            </>
          );
        })()}
      </div>

      <NauticalChart chains={data.chains} globalTotalUsd={data.globalTotalUsd} />

      {/* Table */}
      <DataTableShell
        columns={CHAIN_COLUMNS}
        striped
        sort={{
          sortKey,
          sortDirection,
          toggleSort,
          getAriaSortValue,
          handleSortKeyDown,
        }}
        containerClassName="overflow-y-auto md:max-h-[70vh]"
        tableClassName="w-full"
        headerClassName="sticky top-0 z-10"
      >
        {sorted.map((chain, i) => {
          const rank = i + 1;
          return (
            <InteractiveTableRow
              key={chain.id}
              role="link"
              ariaLabel={`${chain.name} — ${formatCompactUsd(chain.totalUsd)} supply`}
              className="group border-l-2 border-l-transparent transition-all duration-150 hover:border-l-frost-blue hover:bg-muted/30 hover:translate-x-[1px] data-[state=selected]:border-l-frost-blue"
              onActivate={() => router.push(`/chains/${chain.id}/`)}
            >
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {rank}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Image
                      src={chain.logoPath}
                      alt=""
                      width={20}
                      height={20}
                      className={cn("rounded-full", CHAIN_META[chain.id]?.darkInvert ? "dark:invert" : "")}
                      style={{ width: 20, height: 20 }}
                    />
                    <span className="font-medium">{chain.name}</span>
                    <ChainTypeBadge type={chain.type} />
                  </div>
                </TableCell>
                <TableCell>
                  <HealthBadge score={chain.healthScore} band={chain.healthBand} />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatCompactUsd(chain.totalUsd)}</TableCell>
                <TableCell className={cn("text-right font-mono tabular-nums", trendColor(chain.change7dPct))}>
                  {formatSignedPercent(chain.change7dPct * 100, 2)}
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
                <TableCell className="hidden lg:table-cell">
                  <div className="flex items-center gap-2">
                    <StablecoinLogo
                      src={logosById[chain.dominantStablecoin.id]}
                      name={chain.dominantStablecoin.symbol}
                      size={18}
                    />
                    <span className="text-sm">{chain.dominantStablecoin.symbol}</span>
                    <span className="text-xs text-muted-foreground">({(chain.dominantStablecoin.share * 100).toFixed(0)}%)</span>
                  </div>
                </TableCell>
            </InteractiveTableRow>
          );
        })}
      </DataTableShell>
    </div>
    </SectionErrorBoundary>
  );
}
