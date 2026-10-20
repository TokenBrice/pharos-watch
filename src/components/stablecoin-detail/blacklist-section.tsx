"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { DetailModuleCard } from "@/components/stablecoin-detail/module-title";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import { MethodologyLabel } from "@/components/methodology-hint";
import { BlacklistDetailStats } from "./blacklist-detail-stats";
import { BlacklistDetailChart } from "./blacklist-detail-chart";
import { BlacklistDetailEventFeed } from "./blacklist-detail-event-feed";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import type { BlacklistStablecoin } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { QueryStateNotice } from "@/components/query-state-notice";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";

interface BlacklistSectionProps {
  stablecoinId: string;
  symbol: BlacklistStablecoin;
}

function useBlacklistVisibility(symbol: BlacklistStablecoin) {
  const isSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(symbol);
  const query = useBlacklistSummary();
  const { data: summary, isLoading } = query;
  const healthInput = {
    ...DATA_HEALTH_PRESETS.blacklist,
    label: "Blacklist activity data",
    dataUpdatedAt: query.dataUpdatedAt,
    meta: query.meta,
    error: query.error,
    isLoading,
    hasData: !!summary,
  };
  const health = deriveDataHealth(healthInput, query.dataUpdatedAt);

  if (!isSupported) return { visible: false } as const;
  if (!isLoading && !query.error && summary && (summary.stats.perCoinTotalEvents[symbol] ?? 0) === 0) {
    return { visible: false } as const;
  }

  return {
    visible: true,
    summary,
    isLoading,
    state: query.error ? (summary ? "stale-with-data" : "unavailable") : "ready",
    error: query.error,
    dataUpdatedAt: health.dataUpdatedAt,
    healthInput,
    refetch: query.refetch,
  } as const;
}

export function BlacklistSection({ symbol }: BlacklistSectionProps) {
  const state = useBlacklistVisibility(symbol);
  if (!state.visible) return null;
  const { summary, isLoading } = state;

  return (
    <section id="blacklist" className={SECTION_SCROLL_MT}>
      <DetailModuleCard
        title={<MethodologyLabel topic="blacklistTracker">Blacklist activity</MethodologyLabel>}
        bodyClassName="space-y-4"
        headerRight={<FreshnessIndicator
            compact
            updatedAtMs={state.dataUpdatedAt}
            staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.blacklistSummary * 1000}
            labelPrefix="Updated"
          />}
      >
          <p className="mt-1 text-sm text-muted-foreground">
            Addresses the issuer has frozen, released, or destroyed on this asset.
          </p>
          {state.state === "stale-with-data" ? (
            <QueryStateNotice
              state="stale-with-data"
              label="Blacklist activity data"
              dataUpdatedAt={state.dataUpdatedAt}
              onRetry={() => void state.refetch()}
            />
          ) : state.state === "ready" ? <StaleDataBanner queries={[state.healthInput]} /> : null}
          {state.state === "unavailable" ? (
            <QueryStateNotice
              state="unavailable"
              label="Blacklist activity data"
              onRetry={() => void state.refetch()}
            />
          ) : isLoading || !summary ? (
            <>
              <BlacklistDetailStats symbol={symbol} stats={undefined} isLoading />
              <Skeleton className="h-[220px] w-full rounded-xl sm:h-[260px]" />
            </>
          ) : (
            <>
              <BlacklistDetailStats symbol={symbol} stats={summary.stats} isLoading={false} />
              <BlacklistDetailChart data={summary.stats.perCoinQuarterlyEventTypes[symbol]} isLoading={false} />
            </>
          )}
      </DetailModuleCard>
    </section>
  );
}

/**
 * History-zone event log. Activity (`BlacklistSection`) owns everything read
 * from the summary query — stats, the quarterly chart, freshness and the
 * summary's stale/unavailable notices — so none of it repeats here. The
 * summary only gates visibility; the feed reports its own loading, error and
 * empty states from the events query.
 */
export function BlacklistHistorySection({ symbol }: BlacklistSectionProps) {
  const state = useBlacklistVisibility(symbol);
  if (!state.visible) return null;

  return (
    <section id="blacklist-history">
      <DetailModuleCard
        title={<MethodologyLabel topic="blacklistTracker">Recent blacklist events</MethodologyLabel>}
        bodyClassName="space-y-4"
      >
          <p className="mt-1 text-sm text-muted-foreground">
            Latest 10 freeze-ledger actions on this asset across all supported chains.
          </p>
          <BlacklistDetailEventFeed symbol={symbol} limit={10} />
      </DetailModuleCard>
    </section>
  );
}
