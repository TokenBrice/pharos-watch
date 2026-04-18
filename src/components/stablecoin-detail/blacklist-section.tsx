"use client";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { BlacklistDetailStats } from "./blacklist-detail-stats";
import { BlacklistDetailChart } from "./blacklist-detail-chart";
import { BlacklistDetailEventFeed } from "./blacklist-detail-event-feed";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { BLACKLIST_STABLECOINS, type BlacklistStablecoin } from "@shared/types";

interface BlacklistSectionProps {
  stablecoinId: string;
  symbol: BlacklistStablecoin;
}

export function BlacklistSection({ symbol }: BlacklistSectionProps) {
  const isSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(symbol);
  const { data: summary, isLoading, isError } = useBlacklistSummary();

  if (!isSupported) return null;
  if (isError) return null;
  if (!isLoading && summary && (summary.stats.perCoinTotalEvents[symbol] ?? 0) === 0) {
    return null;
  }

  return (
    <>
      <section id="blacklist">
        <Card className="p-4">
          <div className="mb-3">
            <h2 className={DETAIL_SECTION_TITLE_CLASS}>Blacklist Activity</h2>
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
              <BlacklistDetailChart
                data={summary.stats.perCoinQuarterlyEventTypes[symbol]}
                isLoading={false}
              />
            </div>
          )}
        </Card>
      </section>

      <section id="blacklist-history">
        <Card className="p-4">
          <div className="mb-3">
            <h2 className={DETAIL_SECTION_TITLE_CLASS}>Recent Blacklist Events</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Latest 10 freeze-ledger actions on this asset across all supported chains.
            </p>
          </div>
          <BlacklistDetailEventFeed symbol={symbol} limit={10} />
        </Card>
      </section>
    </>
  );
}
