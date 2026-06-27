"use client";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import { MethodologyLabel } from "@/components/methodology-hint";
import { BlacklistDetailStats } from "./blacklist-detail-stats";
import { BlacklistDetailChart } from "./blacklist-detail-chart";
import { BlacklistDetailEventFeed } from "./blacklist-detail-event-feed";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import type { BlacklistStablecoin } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";

interface BlacklistSectionProps {
  stablecoinId: string;
  symbol: BlacklistStablecoin;
}

function useBlacklistVisibility(symbol: BlacklistStablecoin) {
  const isSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(symbol);
  const { data: summary, isLoading, isError } = useBlacklistSummary();

  if (!isSupported) return { visible: false } as const;
  if (isError) return { visible: false } as const;
  if (!isLoading && summary && (summary.stats.perCoinTotalEvents[symbol] ?? 0) === 0) {
    return { visible: false } as const;
  }

  return { visible: true, summary, isLoading } as const;
}

export function BlacklistSection({ symbol }: BlacklistSectionProps) {
  const state = useBlacklistVisibility(symbol);
  if (!state.visible) return null;
  const { summary, isLoading } = state;

  return (
    <section
      id="blacklist"
      className={SECTION_SCROLL_MT}
    >
      <Card className="pharos-card-shell p-4">
        <div className="mb-3">
          <DetailSectionTitle>
            <MethodologyLabel topic="blacklistTracker">Blacklist Activity</MethodologyLabel>
          </DetailSectionTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Addresses the issuer has frozen, released, or destroyed on this asset.
          </p>
        </div>
        {isLoading || !summary ? (
          <div className="space-y-4">
            <BlacklistDetailStats symbol={symbol} stats={undefined} isLoading />
            <Skeleton className="h-[220px] w-full rounded-xl sm:h-[260px]" />
          </div>
        ) : (
          <div className="space-y-4">
            <BlacklistDetailStats symbol={symbol} stats={summary.stats} isLoading={false} />
            <BlacklistDetailChart data={summary.stats.perCoinQuarterlyEventTypes[symbol]} isLoading={false} />
          </div>
        )}
      </Card>
    </section>
  );
}

export function BlacklistHistorySection({ symbol }: BlacklistSectionProps) {
  const state = useBlacklistVisibility(symbol);
  if (!state.visible) return null;

  return (
    <section id="blacklist-history">
      <Card className="pharos-card-shell p-4">
        <div className="mb-3">
          <DetailSectionTitle>
            <MethodologyLabel topic="blacklistTracker">Recent Blacklist Events</MethodologyLabel>
          </DetailSectionTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Latest 10 freeze-ledger actions on this asset across all supported chains.
          </p>
        </div>
        <BlacklistDetailEventFeed symbol={symbol} limit={10} />
      </Card>
    </section>
  );
}
