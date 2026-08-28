"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useChains } from "@/hooks/use-chains";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useSort } from "@/hooks/use-sort";
import { TableCell } from "@/components/table";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { trendColor } from "@/lib/chain-ui";
import { formatCompactUsd, formatSignedPercent, getNetColor } from "@shared/lib/format";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { CHAIN_META } from "@shared/lib/chains";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { logosById } from "@/lib/logos";
import { NauticalChart } from "./nautical-chart";
import { buildChainHarborEntries, buildChainHarborModelFromEntries, HARBOR_MAX } from "./harbor-map";
import { nextHarborSweepId } from "./nautical-scene-math";
import { SelectedHarborPanel } from "./selected-harbor-panel";
import { attachTopStablecoinCargo, sortChains, type ChainSortKey } from "./chain-model";
import { DominanceBreakdown } from "./dominance-breakdown";
import { HealthBadge } from "./health-badge";
const HARBOR_LIGHT_SWEEP_MS = 7_000;

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

export function ChainsLeaderboardClient() {
  const { data, isLoading, isError, error, refetch, dataUpdatedAt, meta } = useChains();
  const stablecoinsQuery = useStablecoins();
  const { sortKey, sortDirection, toggleSort, getAriaSortValue } = useSort<ChainSortKey>("totalUsd", "desc");
  const router = useRouter();
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const chains = data?.chains;
  const globalTotalUsd = data?.globalTotalUsd;

  const sorted = useMemo(() => {
    if (!chains) return [];
    return sortChains(chains, sortKey, sortDirection);
  }, [chains, sortKey, sortDirection]);

  // Top chains by supply for dominance breakdown (independent of table sort)
  const topBySupply = useMemo(() => {
    if (!chains) return [];
    return [...chains].sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 5);
  }, [chains]);

  const chartChains = useMemo(() => {
    if (!chains) return [];
    return attachTopStablecoinCargo(chains, stablecoinsQuery.data?.peggedAssets);
  }, [chains, stablecoinsQuery.data?.peggedAssets]);

  const harborEntries = useMemo(() => {
    if (globalTotalUsd == null) return [];
    return buildChainHarborEntries(chartChains, globalTotalUsd);
  }, [chartChains, globalTotalUsd]);
  const harborModel = useMemo(() => {
    if (globalTotalUsd == null) return undefined;
    return buildChainHarborModelFromEntries(harborEntries, globalTotalUsd);
  }, [harborEntries, globalTotalUsd]);

  const selectedHarbor = useMemo(() => {
    return harborEntries.find((entry) => entry.id === selectedChainId) ?? harborEntries[0] ?? null;
  }, [harborEntries, selectedChainId]);

  const visibleHarborIds = useMemo(() => harborEntries.slice(0, HARBOR_MAX).map((entry) => entry.id), [harborEntries]);

  useEffect(() => {
    if (visibleHarborIds.length <= 1) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;

    const intervalId = window.setInterval(() => {
      setSelectedChainId((currentId) => {
        return nextHarborSweepId(currentId, visibleHarborIds);
      });
    }, HARBOR_LIGHT_SWEEP_MS);

    return () => window.clearInterval(intervalId);
  }, [visibleHarborIds]);

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
      <QueryErrorNotice
        error={error}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }
  if (!data) return null;

  const fallbackGlobalChange7d =
    data.globalTotalUsd > 0
      ? data.chains.reduce((sum, c) => sum + (c.change7dPct || 0) * c.totalUsd, 0) / data.globalTotalUsd
      : 0;
  const change7dPct = (Number.isFinite(data.globalChange7dPct) ? data.globalChange7dPct : fallbackGlobalChange7d) * 100;
  const show7dTrend = Math.abs(change7dPct) >= 0.05;

  return (
    <SectionErrorBoundary name="Chains">
      <div className="space-y-4">
        <QueryFreshnessNotices
          error={error}
          hasData={!!data?.chains?.length}
          onRetry={() => {
            void refetch();
          }}
          queries={[{ preset: "chains", dataUpdatedAt, error, hasData: !!data?.chains?.length, meta }]}
        />

        {/* Hero summary */}
        <div className="pharos-subtle-band space-y-3 py-4">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <p className="pharos-kicker">Total Stablecoin Supply</p>
              <p className="pharos-numeric mt-1 text-3xl font-extrabold tracking-tight text-frost-blue">
                {formatCompactUsd(data.globalTotalUsd)}
              </p>
            </div>
            <div className="flex items-center gap-5 pb-1 text-sm">
              {show7dTrend && (
                <span>
                  <span className="pharos-kicker mr-1.5">7d</span>
                  <span className={cn("pharos-numeric font-semibold", getNetColor(change7dPct))}>
                    {formatSignedPercent(change7dPct, 1)}
                  </span>
                </span>
              )}
              <span>
                <span className="pharos-kicker mr-1.5">Chains</span>
                <span className="pharos-numeric font-semibold">{data.chains.length}</span>
              </span>
            </div>
          </div>

          {/* Dominance breakdown */}
          {topBySupply.length > 0 && (
            <DominanceBreakdown
              topBySupply={topBySupply}
              globalTotalUsd={data.globalTotalUsd}
              chainAttributedTotalUsd={data.chainAttributedTotalUsd}
              unattributedTotalUsd={data.unattributedTotalUsd}
              chains={data.chains}
            />
          )}
        </div>

        <NauticalChart
          chains={chartChains}
          globalTotalUsd={data.globalTotalUsd}
          selectedChainId={selectedHarbor?.id ?? selectedChainId}
          onSelectChain={setSelectedChainId}
          harborModel={harborModel}
        />

        <SelectedHarborPanel entry={selectedHarbor} />

        {/* Table */}
        <p className="sm:hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Swipe table horizontally for health, supply, share, and stablecoin counts.
        </p>
        <DataTableShell
          tableId="chains-leaderboard"
          testId="chains-leaderboard-table"
          columns={CHAIN_COLUMNS}
          striped
          sort={{
            sortKey,
            sortDirection,
            toggleSort,
            getAriaSortValue,
          }}
          mobileScrollHint={false}
          viewportClassName="pb-[calc(var(--mobile-utility-safe-offset)-1rem)] sm:pb-0 md:max-h-[70vh]"
          viewportProps={{ compactBottomPadding: false, vertical: true }}
          tableClassName="min-w-[760px] w-full"
          stickyHeader
        >
          {sorted.map((chain, i) => {
            const rank = i + 1;
            return (
              <InteractiveTableRow
                key={chain.id}
                role="link"
                ariaLabel={`${chain.name} — ${formatCompactUsd(chain.totalUsd)} supply`}
                className="group h-11 border-l-2 border-l-transparent transition-all duration-150 hover:border-l-frost-blue hover:bg-muted/30 hover:translate-x-[1px] data-[state=selected]:border-l-frost-blue sm:h-auto"
                onHover={() => setSelectedChainId(chain.id)}
                onActivate={() => router.push(`/chains/${chain.id}/`)}
              >
                <TableCell className="pharos-numeric text-right text-muted-foreground">{rank}</TableCell>
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
                <TableCell className="text-right pharos-numeric">{formatCompactUsd(chain.totalUsd)}</TableCell>
                <TableCell className={cn("text-right pharos-numeric", trendColor(chain.change7dPct))}>
                  {formatSignedPercent(chain.change7dPct * 100, 2)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/60"
                        style={{ width: `${Math.min(100, chain.dominanceShare * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs pharos-numeric text-muted-foreground w-10 text-right">
                      {(chain.dominanceShare * 100).toFixed(1)}%
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right pharos-numeric">{chain.stablecoinCount}</TableCell>
                <TableCell className="hidden lg:table-cell">
                  <div className="flex items-center gap-2">
                    <StablecoinLogo
                      src={logosById[chain.dominantStablecoin.id]}
                      name={chain.dominantStablecoin.symbol}
                      size={18}
                    />
                    <span className="text-sm">{chain.dominantStablecoin.symbol}</span>
                    <span className="pharos-numeric text-xs text-muted-foreground">
                      ({(chain.dominantStablecoin.share * 100).toFixed(0)}%)
                    </span>
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
