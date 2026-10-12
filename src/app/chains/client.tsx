"use client";

import { useEffect, useMemo } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useChains } from "@/hooks/use-chains";
import { useSort } from "@/hooks/use-sort";
import { TableCell } from "@/components/table";
import { DataTableShell, type DataTableColumn, type DataTableSortControls } from "@/components/data-table-shell";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { trendColor } from "@/lib/chain-ui";
import { formatCompactUsd, formatSignedPercent, getNetColor } from "@shared/lib/format";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { CHAIN_META } from "@shared/types/chain-identity";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { getLogoSrc, logosById } from "@/lib/logos";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { HarborHero } from "@/components/harbor/harbor-hero";
import { HarborSelectionProvider, useHarborSelection } from "@/components/harbor/harbor-selection-context";
import type { ChainSummary } from "@shared/types/chains";
import { sortChains, type ChainSortKey } from "./chain-model";
import { DominanceBreakdown } from "./dominance-breakdown";
import { HealthBadge } from "./health-badge";

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
  const { sortKey, sortDirection, toggleSort, getAriaSortValue } = useSort<ChainSortKey>("totalUsd", "desc");
  const chains = data?.chains;

  const sorted = useMemo(() => {
    if (!chains) return [];
    return sortChains(chains, sortKey, sortDirection);
  }, [chains, sortKey, sortDirection]);

  // Top chains by supply for dominance breakdown (independent of table sort)
  const topBySupply = useMemo(() => {
    if (!chains) return [];
    return [...chains].sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 5);
  }, [chains]);

  const chainIds = useMemo(() => (chains ?? []).map((chain) => chain.id), [chains]);

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
        {/* the harbor's box at its drawn aspect (wide plan / phone portrait), so the scene lands without a shift */}
        <Skeleton className="aspect-[1/2.1] w-full rounded-lg min-[761px]:aspect-[2.6/1]" />
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

  const change7dPct = data.globalChange7dPct == null ? null : data.globalChange7dPct * 100;
  const show7dTrend = change7dPct != null && Math.abs(change7dPct) >= 0.05;
  const coverage = data.supplyCoverage;
  const partialGlobalSupply = (coverage?.aggregateUnavailableAssetCount ?? 0) > 0;

  return (
    <SectionErrorBoundary name="Chains">
      <HarborSelectionProvider chainIds={chainIds}>
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
                <p className="pharos-label">{partialGlobalSupply ? "Partial stablecoin supply" : "Total stablecoin supply"}</p>
                <p className="pharos-numeric mt-1 text-3xl font-extrabold tracking-tight text-foreground">
                  {formatCompactUsd(data.globalTotalUsd)}
                </p>
              </div>
              <div className="flex items-center gap-5 pb-1 text-sm">
                {show7dTrend && (
                  <span>
                    <span className="pharos-label mr-1.5">7d</span>
                    <span className={cn("pharos-numeric font-semibold", getNetColor(change7dPct))}>
                      {formatSignedPercent(change7dPct, 1)}
                    </span>
                  </span>
                )}
                <span title="Chains with at least one observed stablecoin supply row this run; the Chains count in the top strip is the full chain registry.">
                  <span className="pharos-label mr-1.5">Chains with observed supply</span>
                  <span className="pharos-numeric font-semibold">{data.chains.length}</span>
                </span>
              </div>
            </div>
            {coverage && (coverage.aggregateUnavailableAssetCount > 0 || coverage.chainUnavailableObservationCount > 0) ? (
              <p className="text-sm text-muted-foreground">
                Partial supply coverage: {coverage.aggregateUnavailableAssetCount} assets excluded from global supply;{" "}
                {coverage.chainUnavailableObservationCount} unavailable chain observations excluded from chain totals.
                {" "}Shares use observed global supply.
              </p>
            ) : null}

            {/* Dominance breakdown */}
            {topBySupply.length > 0 && (
              <DominanceBreakdown
                topBySupply={topBySupply}
                globalTotalUsd={data.globalTotalUsd}
                chainAttributedTotalUsd={data.chainAttributedTotalUsd}
                unattributedTotalUsd={data.unattributedTotalUsd}
                attributionDiscrepancyUsd={data.attributionDiscrepancyUsd}
                dominanceGeometryTotalUsd={data.dominanceGeometryTotalUsd}
                chains={data.chains}
              />
            )}
          </div>

          <HarborHero data={data} retainedAfterError={isError} />

          <ChainsLeaderboardTable
            sorted={sorted}
            sort={{ sortKey, sortDirection, toggleSort, getAriaSortValue }}
          />
        </div>
      </HarborSelectionProvider>
    </SectionErrorBoundary>
  );
}

/**
 * The leaderboard: the harbor's equivalent data surface. Row hover/focus lights the matching berth; the harbor's
 * "Show in table" scrolls to the row (smoothly only when motion is allowed), focuses it and highlights it.
 */
function ChainsLeaderboardTable({ sorted, sort }: { sorted: readonly ChainSummary[]; sort: DataTableSortControls<ChainSortKey> }) {
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
  const { revealedChainId, setHoverChainId, registerRevealRow } = useHarborSelection();

  useEffect(
    () =>
      registerRevealRow((chainId) => {
        const row = document.getElementById(`chain-row-${chainId}`);
        if (!row) return;
        row.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
        row.focus({ preventScroll: true });
      }),
    [registerRevealRow, reducedMotion],
  );

  return (
    <div
      id="chains-leaderboard"
      tabIndex={-1}
      className="space-y-4 outline-none"
      onMouseLeave={() => setHoverChainId(null)}
      onBlur={(event) => {
        // rows light their berth on focus too: clear it once focus leaves the leaderboard
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoverChainId(null);
      }}
    >
      <p className="sm:hidden text-2xs text-muted-foreground">
        Swipe table horizontally for health, supply, share, and stablecoin counts.
      </p>
      <DataTableShell
        tableId="chains-leaderboard"
        testId="chains-leaderboard-table"
        columns={CHAIN_COLUMNS}
        striped
        sort={sort}
        mobileScrollHint={false}
        // At lg+ the 760px table fits, so drop the scrollers (overflow-clip
        // on the shell, visible viewport) and let the sticky header pin to
        // the page under the site chrome (--table-header-top).
        containerClassName="lg:overflow-clip"
        viewportClassName="pb-[calc(var(--mobile-utility-safe-offset)-1rem)] sm:pb-0 lg:overflow-visible"
        viewportProps={{ compactBottomPadding: false, vertical: true }}
        tableClassName="min-w-[760px] w-full"
        stickyHeader
      >
        {sorted.map((chain, i) => {
          const rank = i + 1;
          return (
            <InteractiveTableRow
              key={chain.id}
              id={`chain-row-${chain.id}`}
              role="link"
              ariaLabel={`${chain.name} — ${formatCompactUsd(chain.totalUsd)} supply`}
              className={cn(
                "group h-11 border-l-2 border-l-transparent transition-all duration-150 hover:border-l-frost-blue hover:bg-muted/30 hover:translate-x-[1px] data-[state=selected]:border-l-frost-blue sm:h-auto",
                revealedChainId === chain.id ? "border-l-frost-blue bg-muted/40" : "",
              )}
              onHover={() => setHoverChainId(chain.id)}
              onActivate={() => router.push(`/chains/${chain.id}/`)}
            >
              <TableCell className="pharos-numeric text-right text-muted-foreground">{rank}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  {chain.logoPath ? (
                    <Image
                      src={chain.logoPath}
                      alt=""
                      width={20}
                      height={20}
                      className={cn("rounded-full", CHAIN_META[chain.id]?.darkInvert ? "dark:invert" : "")}
                      style={{ width: 20, height: 20 }}
                    />
                  ) : (
                    <span aria-hidden="true" className="inline-block h-5 w-5 rounded-full bg-muted" />
                  )}
                  <span className="font-medium">{chain.name}</span>
                  <ChainTypeBadge type={chain.type} />
                </div>
              </TableCell>
              <TableCell>
                <HealthBadge score={chain.healthScore} band={chain.healthBand} />
              </TableCell>
              <TableCell className="text-right pharos-numeric">
                {formatCompactUsd(chain.totalUsd)}
                {(chain.unavailableSupplyObservationCount ?? 0) > 0 ? (
                  <span className="block text-3xs text-muted-foreground">
                    Partial · {chain.unavailableSupplyObservationCount} unavailable
                  </span>
                ) : null}
              </TableCell>
              <TableCell className={cn("text-right pharos-numeric", trendColor(chain.change7dPct))}>
                {chain.change7dPct == null ? "—" : formatSignedPercent(chain.change7dPct * 100, 2)}
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
                    src={getLogoSrc(logosById, chain.dominantStablecoin.id)}
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
  );
}
