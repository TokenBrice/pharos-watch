"use client";

import { useState, useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { DEAD_STABLECOINS, CAUSE_META } from "@/lib/dead-stablecoins";
import { formatCurrency, formatDeathDate } from "@/lib/format";
import type { CauseOfDeath } from "@/lib/types";

type SortKey = "date" | "peakMcap";

const CAUSE_KEYS = Object.keys(CAUSE_META) as CauseOfDeath[];

export function StablecoinCemetery() {
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [causeFilter, setCauseFilter] = useState<CauseOfDeath | null>(null);

  const byPeg = new Map<string, number>();
  const byCause = new Map<CauseOfDeath, number>();
  let totalDestroyed = 0;

  for (const coin of DEAD_STABLECOINS) {
    byPeg.set(coin.pegCurrency, (byPeg.get(coin.pegCurrency) ?? 0) + 1);
    byCause.set(coin.causeOfDeath, (byCause.get(coin.causeOfDeath) ?? 0) + 1);
    if (coin.peakMcap) totalDestroyed += coin.peakMcap;
  }

  const filteredAndSorted = useMemo(() => {
    let list = causeFilter
      ? DEAD_STABLECOINS.filter((c) => c.causeOfDeath === causeFilter)
      : [...DEAD_STABLECOINS];

    if (sortBy === "peakMcap") {
      list = [...list].sort((a, b) => (b.peakMcap ?? 0) - (a.peakMcap ?? 0));
    }
    // "date" is the default order of DEAD_STABLECOINS (chronological), no re-sort needed

    return list;
  }, [sortBy, causeFilter]);

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-zinc-500">
      <CardContent className="space-y-5 pt-6">
        {/* Mini stats */}
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium font-mono tabular-nums">
            {DEAD_STABLECOINS.length} dead
          </span>
          <span className="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium font-mono tabular-nums text-red-500 border-red-500/30">
            {formatCurrency(totalDestroyed, 1)} peak destroyed
          </span>
          {Array.from(byPeg.entries()).map(([peg, count]) => (
            <span
              key={peg}
              className="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium font-mono tabular-nums text-muted-foreground"
            >
              {count} {peg}
            </span>
          ))}
        </div>

        {/* Sort & filter controls */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className="text-sm rounded-lg border border-border bg-background px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="date">Sort by Date</option>
            <option value="peakMcap">Sort by Peak Market Cap</option>
          </select>

          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setCauseFilter(null)}
              className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                causeFilter === null
                  ? "bg-foreground text-background border-foreground"
                  : "text-muted-foreground border-border hover:text-foreground hover:border-foreground/50"
              }`}
            >
              All
            </button>
            {CAUSE_KEYS.map((key) => {
              const meta = CAUSE_META[key];
              const isActive = causeFilter === key;
              return (
                <button
                  key={key}
                  onClick={() => setCauseFilter(isActive ? null : key)}
                  className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                    isActive
                      ? `${meta.textColor} ${meta.borderColor} bg-foreground/5`
                      : "text-muted-foreground border-border hover:text-foreground hover:border-foreground/30"
                  }`}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Obituary list */}
        <div className="rounded-xl border divide-y divide-border">
          {filteredAndSorted.map((coin) => {
            const cause = CAUSE_META[coin.causeOfDeath];
            return (
              <div key={coin.symbol} id={`obituary-${coin.symbol}`} className="px-4 py-3.5 space-y-1.5 transition-all duration-500">
                {/* Row 1: symbol, death date, peak mcap, cause badge */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold line-through decoration-zinc-500">
                      {coin.symbol}
                    </span>
                    <span className="text-sm">☠️</span>
                    <span className="text-sm font-mono tabular-nums text-muted-foreground">
                      {formatDeathDate(coin.deathDate)}
                    </span>
                    {coin.peakMcap && (
                      <span className="text-xs font-mono tabular-nums text-muted-foreground/60">
                        peak {formatCurrency(coin.peakMcap, 1)}
                      </span>
                    )}
                  </div>
                  <span
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${cause.textColor} ${cause.borderColor}`}
                  >
                    {cause.label}
                  </span>
                </div>

                {/* Row 2: name + peg */}
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{coin.name}</span>
                  <span className="text-xs font-mono text-muted-foreground/60">
                    {coin.pegCurrency}
                  </span>
                </div>

                {/* Row 3: obituary */}
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {coin.obituary}
                </p>

                {/* Row 4: source link */}
                <a
                  href={coin.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {coin.sourceLabel}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            );
          })}

          {filteredAndSorted.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No stablecoins match this filter.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
