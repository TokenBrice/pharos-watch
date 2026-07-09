"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import { MethodologyLabel } from "@/components/methodology-hint";
import { BlacklistDetailStats } from "./blacklist-detail-stats";
import { BlacklistDetailChart } from "./blacklist-detail-chart";
import { BlacklistDetailEventFeed } from "./blacklist-detail-event-feed";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import type { BlacklistStablecoin } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { QueryStateNotice } from "@/components/query-state-notice";

interface BlacklistSectionProps {
  stablecoinId: string;
  symbol: BlacklistStablecoin;
}

function useBlacklistVisibility(symbol: BlacklistStablecoin) {
  const isSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(symbol);
  const query = useBlacklistSummary();
  const { data: summary, isLoading } = query;

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
    dataUpdatedAt: query.dataUpdatedAt,
    refetch: query.refetch,
  } as const;
}

export function BlacklistSection({ symbol }: BlacklistSectionProps) {
  const state = useBlacklistVisibility(symbol);
  if (!state.visible) return null;
  const { summary, isLoading } = state;

  return (
    <section id="blacklist" className={SECTION_SCROLL_MT}>
      <Card className={DETAIL_MODULE_SHELL_CLASS}>
        <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
          <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>
            <MethodologyLabel topic="blacklistTracker">Blacklist Activity</MethodologyLabel>
          </DetailSectionTitle>
        </CardHeader>
        <CardContent className={`${DETAIL_MODULE_BODY_CLASS} space-y-4`}>
          <p className="mt-1 text-sm text-muted-foreground">
            Addresses the issuer has frozen, released, or destroyed on this asset.
          </p>
          {state.state === "unavailable" ? (
            <QueryStateNotice
              state="unavailable"
              label="Blacklist activity data"
              onRetry={() => void state.refetch()}
            />
          ) : isLoading || !summary ? (
            <>
              {state.state === "stale-with-data" ? (
                <QueryStateNotice
                  state="stale-with-data"
                  label="Blacklist activity data"
                  dataUpdatedAt={state.dataUpdatedAt}
                  onRetry={() => void state.refetch()}
                />
              ) : null}
              <BlacklistDetailStats symbol={symbol} stats={undefined} isLoading />
              <Skeleton className="h-[220px] w-full rounded-xl sm:h-[260px]" />
            </>
          ) : (
            <>
              <BlacklistDetailStats symbol={symbol} stats={summary.stats} isLoading={false} />
              <BlacklistDetailChart data={summary.stats.perCoinQuarterlyEventTypes[symbol]} isLoading={false} />
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export function BlacklistHistorySection({ symbol }: BlacklistSectionProps) {
  const state = useBlacklistVisibility(symbol);
  if (!state.visible) return null;

  return (
    <section id="blacklist-history">
      <Card className={DETAIL_MODULE_SHELL_CLASS}>
        <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
          <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>
            <MethodologyLabel topic="blacklistTracker">Recent Blacklist Events</MethodologyLabel>
          </DetailSectionTitle>
        </CardHeader>
        <CardContent className={`${DETAIL_MODULE_BODY_CLASS} space-y-4`}>
          <p className="mt-1 text-sm text-muted-foreground">
            Latest 10 freeze-ledger actions on this asset across all supported chains.
          </p>
          {state.state === "unavailable" ? (
            <QueryStateNotice
              state="unavailable"
              label="Blacklist activity data"
              onRetry={() => void state.refetch()}
            />
          ) : (
            <>
              {state.state === "stale-with-data" ? (
                <QueryStateNotice
                  state="stale-with-data"
                  label="Blacklist activity data"
                  dataUpdatedAt={state.dataUpdatedAt}
                  onRetry={() => void state.refetch()}
                />
              ) : null}
              <BlacklistDetailEventFeed symbol={symbol} limit={10} />
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
