"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { CHAIN_META } from "@shared/types/chain-identity";
import type { CoinState } from "@shared/lib/coin-state";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { CoinStateChip } from "@/components/coin-state-chip";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { useChainProfileData } from "@/hooks/use-chain-profile-data";
import { useCoinStates } from "@/hooks/use-coin-states";
import { BackingBreakdown } from "./backing-breakdown";
import { CompositionSection } from "./composition-section";
import { StablecoinTable } from "./stablecoin-table";
import { ChainHero } from "./chain-hero";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { buildChainRouteViewModel } from "./view-model";

/**
 * Tracked coins still deployed on a chain the read has no row for keep their
 * exceptional states; the status line names any critical or paused one, so a
 * halted chain never reads as merely untracked.
 */
function TrackedCoinStates({ coins, coinStates }: {
  coins: readonly { id: string; name: string; symbol: string }[];
  coinStates: ReadonlyMap<string, readonly CoinState[]>;
}) {
  const named = coins.flatMap((coin) => {
    const state = coinStates.get(coin.id)?.find((entry) => entry.kind === "critical" || entry.kind === "paused");
    return state && "notice" in state ? [`${coin.symbol} — ${state.notice.title}${state.notice.asOf ? ` (updated ${state.notice.asOf})` : ""}`] : [];
  });
  return (
    <>
      {named.length > 0 ? (
        <p className="text-sm text-foreground">
          {named.length} tracked {named.length === 1 ? "coin reports" : "coins report"} a critical or paused state: {named.join("; ")}.
        </p>
      ) : null}
      <ul className="space-y-1.5 text-sm" aria-label="Tracked stablecoins on this chain">
        {coins.map((coin) => {
          const state = coinStates.get(coin.id)?.[0];
          return (
            <li key={coin.id} className="flex flex-wrap items-center gap-2">
              <Link href={buildStablecoinUrl(coin.id)} prefetch={false} className="pharos-focus-ring rounded-sm font-medium hover:underline">
                {coin.name} <span className="text-muted-foreground">({coin.symbol})</span>
              </Link>
              {state ? <CoinStateChip state={state} showDetail /> : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function ChainProfileClient({ chainId }: { chainId: string }) {
  const meta = CHAIN_META[chainId];
  const [backingFilter, setBackingFilter] = useState<string | null>(null);
  const {
    chain,
    coins,
    totalUsd,
    canConfirmMissingChain,
    supplyCoverage,
    supplyUnavailable,
    hasAnyData,
    routeError,
    chainsQuery,
    refetchAll,
  } = useChainProfileData(chainId);
  const { byId: coinStates } = useCoinStates();
  const trackedCoins = useMemo(() => CLIENT_ACTIVE_STABLECOINS.filter((coin) => coin.chainIds?.includes(chainId)), [chainId]);
  // A settled read with no row for this chain: unavailable, never a perpetual loading state.
  const unread = !chain && (canConfirmMissingChain || supplyUnavailable || routeError != null);

  const routeModel = useMemo(
    () => totalUsd != null ? buildChainRouteViewModel(coins, totalUsd) : null,
    [coins, totalUsd],
  );

  const filteredCoins = useMemo(() => {
    if (!routeModel) return [];
    if (!backingFilter) {
      return routeModel.coins;
    }
    return routeModel.coins.filter((coin) => (coin.backing ?? "other") === backingFilter);
  }, [routeModel, backingFilter]);

  const hero = meta ? (
    <ChainHero meta={meta} chain={chain} apiMeta={chainsQuery.meta} dataUpdatedAt={chainsQuery.dataUpdatedAt} supplyCoverage={supplyCoverage} unavailable={unread} />
  ) : null;

  if (routeError && !hasAnyData) {
    return (
      <div className="space-y-6">
        {hero}
        <QueryErrorNotice error={routeError} onRetry={() => { void refetchAll(); }} />
      </div>
    );
  }

  if (supplyUnavailable) {
    return (
      <div className="space-y-6">
        {hero}
        <div className="space-y-3" role="status">
          <p className="text-sm text-muted-foreground">
            Supply data is unavailable for this chain in the available snapshot; all current observations were excluded.
          </p>
          {trackedCoins.length > 0 ? <TrackedCoinStates coins={trackedCoins} coinStates={coinStates} /> : null}
        </div>
        <QueryErrorNotice error={routeError} hasData={hasAnyData} onRetry={() => { void refetchAll(); }} />
        <button type="button" className="pharos-focus-ring text-sm text-primary hover:underline" onClick={() => { void refetchAll(); }}>
          Retry chain data
        </button>
      </div>
    );
  }
  if (!chain && canConfirmMissingChain && trackedCoins.length > 0) {
    return (
      <div className="space-y-6">
        {hero}
        <div className="space-y-3 rounded-xl border border-border/60 px-4 py-4" role="status">
          <p className="font-medium">Pharos doesn&apos;t have a chain read for {meta?.name ?? chainId}.</p>
          <TrackedCoinStates coins={trackedCoins} coinStates={coinStates} />
        </div>
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
        {/* Retained data for this chain silences a failed refresh (ADR-42); a missing chain read does not. */}
        <QueryErrorNotice error={routeError} hasData={hasAnyData && chain != null} onRetry={() => { void refetchAll(); }} />
        {/* materially stale data is the hero's status chip; the body only reports a hard error */}
        {hero}
        {chain && (
          <ShowYourWorkPanel
            kind="chain-health"
            factors={chain.healthFactors}
            chainEnvironmentEvidence={chain.chainEnvironmentEvidence}
            chainName={chain.name}
          />
        )}
        {chain && routeModel && (
          <>
            <CompositionSection model={routeModel} />
            <BackingBreakdown
              model={routeModel}
              onFilterChange={setBackingFilter}
              activeFilter={backingFilter}
            />
            <StablecoinTable coins={filteredCoins} backingFilter={backingFilter} coinStates={coinStates} />
          </>
        )}
      </div>
    </SectionErrorBoundary>
  );
}
