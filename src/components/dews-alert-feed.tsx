"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { DEWSBadge } from "@/components/dews-badge";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { getDewsAmplifiers, getTopDewsContributors } from "@/lib/dews-signal-utils";
import { CLIENT_PSI_ELIGIBLE_META_BY_ID as PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible-client";
import type { StressSignalEntry } from "@shared/types";
import { THREAT_BAND_ORDER, isThreatBand, type ThreatBand } from "@shared/lib/classification";

interface DEWSAlertFeedProps {
  signals?: Record<string, StressSignalEntry>;
  logos?: Record<string, string>;
  allowedIds?: Set<string>;
  className?: string;
}

interface AlertCoin {
  id: string;
  symbol: string;
  name: string;
  score: number;
  band: ThreatBand;
  entry: StressSignalEntry;
}

const PAGE_SIZE = 3;

export function DEWSAlertFeed({ signals, logos, allowedIds, className }: DEWSAlertFeedProps) {
  const prefetch = usePrefetchStablecoin();
  const [page, setPage] = useState(0);

  const alertCoins = useMemo((): AlertCoin[] => {
    if (!signals) return [];

    const result: AlertCoin[] = [];
    for (const [id, entry] of Object.entries(signals)) {
      if (allowedIds && !allowedIds.has(id)) continue;
      if (!isThreatBand(entry.band)) continue;
      if ((THREAT_BAND_ORDER[entry.band] ?? 0) < THREAT_BAND_ORDER.ALERT) continue;

      const meta = PSI_ELIGIBLE_META_BY_ID.get(id);
      result.push({
        id,
        symbol: meta?.symbol ?? id,
        name: meta?.name ?? id,
        score: entry.score,
        band: entry.band,
        entry,
      });
    }

    result.sort((a, b) => {
      const bandDelta = (THREAT_BAND_ORDER[b.band] ?? 0) - (THREAT_BAND_ORDER[a.band] ?? 0);
      if (bandDelta !== 0) return bandDelta;
      if (b.score !== a.score) return b.score - a.score;
      return a.symbol.localeCompare(b.symbol);
    });

    return result;
  }, [signals, allowedIds]);

  const totalPages = Math.max(1, Math.ceil(alertCoins.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageCoins = alertCoins.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  if (!signals) {
    return (
      <div className={cn("pharos-card-shell flex flex-col p-4", className)}>
        <h2 className="pb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          DEWS Alert Queue
        </h2>
        <div className="space-y-2">
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn("pharos-card-shell flex flex-col p-4", className)}>
      <div className="flex items-center justify-between gap-2 pb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          DEWS Alert Queue
        </h2>
        <span className="pharos-numeric text-xs text-muted-foreground">
          {alertCoins.length} at alert+
        </span>
      </div>
      <div className="grid flex-1 grid-cols-1 gap-y-1.5" aria-live="polite">
        {alertCoins.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-sm text-muted-foreground">
            All coins with current DEWS coverage are below ALERT.
          </p>
        ) : (
          pageCoins.map((coin) => {
            const top = getTopDewsContributors(coin.entry.signals, 2);
            const amplifiers = getDewsAmplifiers(coin.entry);
            return (
            <Link
              key={coin.id}
              href={buildStablecoinUrl(coin.id)}
              className="pharos-focus-ring flex items-center justify-between gap-3 py-2 px-2 min-h-11 rounded-lg hover:bg-accent/50 transition-colors group"
              onMouseEnter={() => prefetch(coin.id)}
            >
              <div className="flex items-center gap-3 min-w-0">
                <StablecoinLogo src={logos?.[coin.id]} name={coin.symbol} size={20} />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate group-hover:underline">{coin.symbol}</div>
                  <div className="text-xs text-muted-foreground truncate">{coin.name}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {top.length > 0 ? top.map((item) => item.shortLabel).join(", ") : "no active drivers"}
                    {amplifiers.length > 0 ? ` · ${amplifiers.map((amp) => `${amp.label} ${amp.value.toFixed(2)}x`).join(", ")}` : ""}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                <DEWSBadge score={coin.score} band={coin.band} />
                <span className="pharos-numeric w-6 text-right text-xs text-muted-foreground">
                  {coin.score}
                </span>
              </div>
            </Link>
            );
          })
        )}
      </div>
      {totalPages > 1 && (
        <div className="-mx-4 -mb-4 mt-2 flex items-center justify-between border-t border-border/60 px-4 py-2">
          <button
            type="button"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
            className="min-h-11 sm:min-h-0 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed pharos-focus-ring"
            aria-label="Previous page"
          >
            ← Prev
          </button>
          <span className="pharos-numeric text-xs text-muted-foreground">
            {safePage + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage(safePage + 1)}
            className="min-h-11 sm:min-h-0 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed pharos-focus-ring"
            aria-label="Next page"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
