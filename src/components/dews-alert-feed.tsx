"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { DEWSBadge } from "@/components/dews-badge";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { buildStablecoinUrl } from "@/lib/urls";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
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
      <Card className={["rounded-xl flex flex-col", className].filter(Boolean).join(" ")}>
        <CardHeader className="pb-3">
          <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            DEWS Alert Queue
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={["rounded-xl flex flex-col", className].filter(Boolean).join(" ")}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            DEWS Alert Queue
          </CardTitle>
          <span className="text-xs font-mono tabular-nums text-muted-foreground">
            {alertCoins.length} at alert+
          </span>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-y-1.5" aria-live="polite">
        {alertCoins.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-sm text-muted-foreground">
            All tracked stablecoins are below ALERT right now.
          </p>
        ) : (
          pageCoins.map((coin) => (
            <Link
              key={coin.id}
              href={buildStablecoinUrl(coin.id)}
              className="flex items-center justify-between gap-3 py-2 px-2 rounded-lg hover:bg-accent/50 transition-colors group"
              onMouseEnter={() => prefetch(coin.id)}
            >
              <div className="flex items-center gap-3 min-w-0">
                <StablecoinLogo src={logos?.[coin.id]} name={coin.symbol} size={20} />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate group-hover:underline">{coin.symbol}</div>
                  <div className="text-xs text-muted-foreground truncate">{coin.name}</div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                <DEWSBadge score={coin.score} band={coin.band} />
                <span className="w-6 text-right text-xs font-mono tabular-nums text-muted-foreground">
                  {coin.score}
                </span>
              </div>
            </Link>
          ))
        )}
      </CardContent>
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border/60 px-4 py-2">
          <button
            type="button"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed pharos-focus-ring"
          >
            ← Prev
          </button>
          <span className="text-xs font-mono tabular-nums text-muted-foreground">
            {safePage + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage(safePage + 1)}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed pharos-focus-ring"
          >
            Next →
          </button>
        </div>
      )}
    </Card>
  );
}
