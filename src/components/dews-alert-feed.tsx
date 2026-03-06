"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { DEWSBadge } from "@/components/dews-badge";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { BAND_ORDER } from "@/lib/depeg-sort";
import { buildStablecoinUrl } from "@/lib/urls";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import type { StressSignalEntry } from "@shared/types";
import type { ThreatBand } from "@shared/lib/classification";

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

function isThreatBand(value: string): value is ThreatBand {
  return Object.prototype.hasOwnProperty.call(BAND_ORDER, value);
}

export function DEWSAlertFeed({ signals, logos, allowedIds, className }: DEWSAlertFeedProps) {
  const prefetch = usePrefetchStablecoin();

  const alertCoins = useMemo((): AlertCoin[] => {
    if (!signals) return [];

    const result: AlertCoin[] = [];
    for (const [id, entry] of Object.entries(signals)) {
      if (allowedIds && !allowedIds.has(id)) continue;
      if (!isThreatBand(entry.band)) continue;
      if ((BAND_ORDER[entry.band] ?? 0) < BAND_ORDER.ALERT) continue;

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
      const bandDelta = (BAND_ORDER[b.band] ?? 0) - (BAND_ORDER[a.band] ?? 0);
      if (bandDelta !== 0) return bandDelta;
      if (b.score !== a.score) return b.score - a.score;
      return a.symbol.localeCompare(b.symbol);
    });

    return result;
  }, [signals, allowedIds]);

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
      <CardContent className="flex-1 overflow-y-auto grid grid-cols-1 gap-y-1.5" aria-live="polite">
        {alertCoins.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-sm text-muted-foreground">
            All tracked stablecoins are below ALERT right now.
          </p>
        ) : (
          alertCoins.map((coin) => (
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
    </Card>
  );
}
