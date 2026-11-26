"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock, Info } from "lucide-react";
import { CHAIN_META } from "@shared/types/chain-identity";
import { daysUntilIsoDate, isSpentDeadline, type CoinState } from "@shared/lib/coin-state";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinClientAlert } from "@shared/types/stablecoin-client-meta";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatNoticeDeadline } from "@/components/coin-notice";
import { CoinStateChip } from "@/components/coin-state-chip";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { useChainProfileData } from "@/hooks/use-chain-profile-data";
import { useCoinStates } from "@/hooks/use-coin-states";
import { useUtcDayNowMs } from "@/hooks/use-utc-day-clock";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { BackingBreakdown } from "./backing-breakdown";
import { CompositionSection } from "./composition-section";
import { StablecoinTable } from "./stablecoin-table";
import { ChainHero } from "./chain-hero";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { buildChainRouteViewModel } from "./view-model";

type ScopedNoticeGroup = {
  key: string;
  alert: StablecoinClientAlert;
  coins: (typeof CLIENT_ACTIVE_STABLECOINS)[number][];
};

/**
 * Notices tracked coins scope to this chain (a chain-only cutoff, a bridge
 * sunset), read from the curated list projection so they show whatever the
 * chain read says and however far off the date is. Coins sharing one event
 * (same type, title and date) share one row. Resolved history never shows; a
 * spent deadline drops once the visitor's clock is known.
 */
function ChainScopedNotices({ chainId, chainName }: { chainId: string; chainName: string }) {
  const nowMs = useUtcDayNowMs();
  const nowSec = nowMs === null ? null : nowMs / 1000;
  const groups = useMemo(() => {
    const byKey = new Map<string, ScopedNoticeGroup>();
    for (const coin of CLIENT_ACTIVE_STABLECOINS) {
      for (const alert of coin.alerts ?? []) {
        if (!alert.chains?.includes(chainId) || alert.kind === "history") continue;
        if (nowSec !== null && isSpentDeadline(alert, nowSec)) continue;
        const key = [alert.type, alert.title, alert.deadline ?? ""].join("|");
        const group = byKey.get(key);
        if (!group) byKey.set(key, { key, alert, coins: [coin] });
        else if (!group.coins.includes(coin)) group.coins.push(coin);
      }
    }
    // Earliest date first, dateless last; ties keep first-seen registry order.
    return Array.from(byKey.values()).sort(({ alert: { deadline: x } }, { alert: { deadline: y } }) =>
      x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1);
  }, [chainId, nowSec]);
  if (groups.length === 0) return null;
  const tone = groups.some(({ alert }) => alert.type !== "info") ? "caution" : "info";
  return (
    <section
      aria-labelledby="chain-scoped-notices-heading"
      className={cn("flex items-start gap-3 rounded-lg border px-4 py-3", SEVERITY_TONE_CLASS[tone].banner)}
      data-chain-scoped-notices
    >
      <CalendarClock aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", SEVERITY_TONE_CLASS[tone].text)} />
      <div className="min-w-0 flex-1">
        <h2 id="chain-scoped-notices-heading" className="text-sm font-semibold text-foreground">
          {groups.length === 1 ? "Holder notice" : "Holder notices"} for {chainName}
        </h2>
        <ul className="mt-1 space-y-1 text-sm">
          {groups.map(({ key, alert, coins }) => (
            <li key={key} className="flex flex-wrap items-baseline gap-x-2">
              <span>
                {coins.map((coin, index) => (
                  <Fragment key={coin.id}>
                    {index > 0 ? ", " : null}
                    <Link
                      href={buildStablecoinUrl(coin.id)}
                      prefetch={false}
                      className="pharos-focus-ring rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                    >
                      {coin.symbol}
                    </Link>
                  </Fragment>
                ))}
                : <span className="font-normal text-foreground/80">{alert.title}</span>
              </span>
              {/* Flex gaps drop whitespace visually; the space keeps "closes Jan 12" in the text and accessible name. */}
              {" "}
              {alert.deadline ? (
                <span className="text-xs font-medium text-muted-foreground" data-notice-deadline={alert.deadline}>
                  {formatNoticeDeadline(alert.deadline, daysUntilIsoDate(alert.deadline, nowSec))}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * Tracked coins still deployed on a chain the read has no row for keep their
 * exceptional states; the status line names any critical, paused or deadline
 * one, so a halted or closing chain never reads as merely untracked. A
 * deadline scoped to this chain is left to the holder notices above it.
 */
function TrackedCoinStates({ chainId, coins, coinStates }: {
  chainId: string;
  coins: readonly { id: string; name: string; symbol: string }[];
  coinStates: ReadonlyMap<string, readonly CoinState[]>;
}) {
  const named = coins.flatMap((coin) => {
    const state = coinStates.get(coin.id)?.find((entry) => entry.kind === "critical" || entry.kind === "paused" || entry.kind === "deadline");
    if (!state || !("notice" in state)) return [];
    if (state.kind === "deadline" && state.notice.chains?.includes(chainId)) return [];
    const note = state.kind === "deadline"
      ? ` (${formatNoticeDeadline(state.notice.deadline, state.daysToDeadline)})`
      : state.notice.asOf ? ` (updated ${state.notice.asOf})` : "";
    return [`${coin.symbol}: ${state.notice.title}${note}`];
  });
  return (
    <>
      {named.length > 0 ? (
        <p className="text-sm text-foreground">
          {named.length} tracked {named.length === 1 ? "coin reports" : "coins report"} a critical, paused or deadline state: {named.join("; ")}.
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
  const { byId: coinStates } = useCoinStates({ chainId });
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
  // Chain-scoped holder notices sit under the hero in every state of the chain read.
  const chainNotices = <ChainScopedNotices chainId={chainId} chainName={meta?.name ?? chain?.name ?? chainId} />;

  if (routeError && !hasAnyData) {
    return (
      <div className="space-y-6">
        {hero}
        {chainNotices}
        <QueryErrorNotice error={routeError} onRetry={() => { void refetchAll(); }} />
      </div>
    );
  }

  if (supplyUnavailable) {
    return (
      <div className="space-y-6">
        {hero}
        {chainNotices}
        <div className="space-y-3" role="status">
          <p className="text-sm text-muted-foreground">
            Supply data is unavailable for this chain in the available snapshot; all current observations were excluded.
          </p>
          {trackedCoins.length > 0 ? <TrackedCoinStates chainId={chainId} coins={trackedCoins} coinStates={coinStates} /> : null}
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
        {chainNotices}
        <div className="space-y-3 rounded-xl border border-border/60 px-4 py-4" role="status">
          <p className="font-medium">Pharos doesn&apos;t have a chain read for {meta?.name ?? chainId}.</p>
          <TrackedCoinStates chainId={chainId} coins={trackedCoins} coinStates={coinStates} />
        </div>
      </div>
    );
  }
  if (!chain && canConfirmMissingChain) {
    return (
      <div className="space-y-6">
        {hero}
        {chainNotices}
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
        {chainNotices}
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
