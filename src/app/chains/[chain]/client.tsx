"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { useChainProfileData } from "@/hooks/use-chain-profile-data";
import {
  BackingBreakdown,
  CompositionSection,
  DetailedSectionsNotice,
  HealthBreakdownCard,
  HeroCard,
  StablecoinTable,
} from "./detail-sections";
import { buildChainRouteViewModel } from "./view-model";

export function ChainProfileClient({ chainId }: { chainId: string }) {
  const [backingFilter, setBackingFilter] = useState<string | null>(null);
  const {
    chain,
    coins,
    totalUsd,
    canRenderDetailedSections,
    canConfirmMissingChain,
    detailedSectionNotice,
    hasAnyData,
    isInitialLoading,
    routeError,
    chainsQuery,
    stablecoinsQuery,
    refetchAll,
  } = useChainProfileData(chainId);

  const routeModel = useMemo(
    () => buildChainRouteViewModel(coins, totalUsd),
    [coins, totalUsd],
  );

  const filteredCoins = useMemo(() => {
    if (!backingFilter) {
      return routeModel.coins;
    }
    return routeModel.coins.filter((coin) => (coin.backing ?? "other") === backingFilter);
  }, [routeModel.coins, backingFilter]);

  if (isInitialLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
      </div>
    );
  }

  if (routeError && !hasAnyData) {
    return <QueryErrorNotice error={routeError} onRetry={() => { void refetchAll(); }} />;
  }

  if (!chain && canConfirmMissingChain) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <div className="rounded-full bg-muted p-4">
          <Info className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="font-medium">No data available for this chain</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This chain may not be tracked or may have been removed.
          </p>
        </div>
        <Link href="/chains/" className="pharos-focus-ring text-sm text-primary hover:underline">
          View all chains
        </Link>
      </div>
    );
  }

  if (!chain) {
    return (
      <QueryErrorNotice
        error={routeError ?? new Error("Chain summary is temporarily unavailable.")}
        hasData={hasAnyData}
        onRetry={() => { void refetchAll(); }}
      />
    );
  }

  return (
    <SectionErrorBoundary name="Chain Detail">
      <div className="space-y-6">
        <QueryErrorNotice error={routeError} hasData={hasAnyData} onRetry={() => { void refetchAll(); }} />
        <StaleDataBanner
          queries={[
            {
              preset: "chains",
              dataUpdatedAt: chainsQuery.dataUpdatedAt,
              error: chainsQuery.error,
              hasData: !!chainsQuery.data?.chains?.length,
              meta: chainsQuery.meta,
            },
            {
              preset: "stablecoins",
              dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
              error: stablecoinsQuery.error,
              hasData: stablecoinsQuery.meta != null || stablecoinsQuery.dataUpdatedAt > 0,
              meta: stablecoinsQuery.meta,
            },
          ]}
        />
        <HeroCard chain={chain} chainId={chainId} />
        <HealthBreakdownCard chain={chain} meta={chainsQuery.meta} />
        {canRenderDetailedSections ? (
          <>
            <CompositionSection model={routeModel} />
            <BackingBreakdown
              model={routeModel}
              onFilterChange={setBackingFilter}
              activeFilter={backingFilter}
            />
            <StablecoinTable coins={filteredCoins} backingFilter={backingFilter} />
          </>
        ) : (
          detailedSectionNotice ? (
            <DetailedSectionsNotice message={detailedSectionNotice} onRetry={() => { void refetchAll(); }} />
          ) : null
        )}
      </div>
    </SectionErrorBoundary>
  );
}
