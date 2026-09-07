"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { CHAIN_META } from "@shared/lib/chains";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { useChainProfileData } from "@/hooks/use-chain-profile-data";
import {
  BackingBreakdown,
  CompositionSection,
  StablecoinTable,
} from "./detail-sections";
import { ChainHero } from "./chain-hero";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { buildChainRouteViewModel } from "./view-model";

export function ChainProfileClient({ chainId }: { chainId: string }) {
  const meta = CHAIN_META[chainId];
  const [backingFilter, setBackingFilter] = useState<string | null>(null);
  const {
    chain,
    coins,
    totalUsd,
    canConfirmMissingChain,
    hasAnyData,
    routeError,
    chainsQuery,
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

  const hero = meta ? (
    <ChainHero meta={meta} chain={chain} apiMeta={chainsQuery.meta} />
  ) : null;

  if (routeError && !hasAnyData) {
    return (
      <div className="space-y-6">
        {hero}
        <QueryErrorNotice error={routeError} onRetry={() => { void refetchAll(); }} />
      </div>
    );
  }

  if (!chain && canConfirmMissingChain) {
    return (
      <div className="space-y-6">
        {hero}
        <div className="flex flex-col items-center justify-center gap-4 py-12">
          <div className="rounded-full bg-muted p-4">
            <Info className="h-8 w-8 text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="font-medium">Pharos doesn&apos;t have a chain read for this one yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              This chain may not be tracked or may have been removed.
            </p>
          </div>
          <Link href="/chains/" className="pharos-focus-ring text-sm text-primary hover:underline">
            View all chains
          </Link>
        </div>
      </div>
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
          ]}
        />
        {hero}
        {chain && (
          <ShowYourWorkPanel
            kind="chain-health"
            factors={chain.healthFactors}
            chainEnvironmentEvidence={chain.chainEnvironmentEvidence}
            chainName={chain.name}
          />
        )}
        {chain && (
          <>
            <CompositionSection model={routeModel} />
            <BackingBreakdown
              model={routeModel}
              onFilterChange={setBackingFilter}
              activeFilter={backingFilter}
            />
            <StablecoinTable coins={filteredCoins} backingFilter={backingFilter} />
          </>
        )}
      </div>
    </SectionErrorBoundary>
  );
}
