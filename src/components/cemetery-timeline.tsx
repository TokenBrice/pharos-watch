"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DEAD_STABLECOINS, CAUSE_META } from "@/lib/dead-stablecoins";
import { formatCurrency, formatDeathDateShort } from "@/lib/format";
import type { DeadStablecoin } from "@/lib/types";

/** Parse "YYYY-MM" to a timestamp for positioning. */
function deathTs(d: string): number {
  const [y, m] = d.split("-").map(Number);
  return new Date(y, (m || 1) - 1).getTime();
}

/** Color for the cause dot border. */
const CAUSE_BORDER: Record<string, string> = {
  "algorithmic-failure": "border-red-500",
  "counterparty-failure": "border-amber-500",
  "liquidity-drain": "border-orange-500",
  "regulatory": "border-blue-500",
  "abandoned": "border-zinc-500",
};

export function CemeteryTimeline() {
  const [hovered, setHovered] = useState<DeadStablecoin | null>(null);
  const [tapped, setTapped] = useState<string | null>(null);

  const handleMarkerClick = useCallback((symbol: string) => {
    setTapped((prev) => (prev === symbol ? null : symbol));
  }, []);

  const coins = DEAD_STABLECOINS.filter((c) => c.symbol !== "USNBT");
  if (coins.length === 0) return null;

  const timestamps = coins.map((c) => deathTs(c.deathDate));
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const range = maxTs - minTs || 1;

  // Generate year tick marks
  const startYear = new Date(minTs).getFullYear();
  const endYear = new Date(maxTs).getFullYear();
  const yearTicks: { year: number; pct: number }[] = [];
  for (let y = startYear; y <= endYear; y++) {
    const ts = new Date(y, 0).getTime();
    const pct = ((ts - minTs) / range) * 100;
    if (pct >= 0 && pct <= 100) yearTicks.push({ year: y, pct });
  }

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Timeline of Deaths
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative overflow-x-auto px-4 pb-4">
          <div className="relative" style={{ height: 100, minWidth: 500 }}>
            {/* Horizontal axis line */}
            <div className="absolute left-0 right-0 top-[50px] h-px bg-border" />

            {/* Year labels — above the axis line */}
            {yearTicks.map((t) => (
              <div
                key={t.year}
                className="absolute bottom-full -translate-x-1/2 flex flex-col items-center"
                style={{ left: `${t.pct}%`, top: 0 }}
              >
                <span className="text-[10px] text-muted-foreground font-mono">
                  {t.year}
                </span>
                <div className="h-2 w-px bg-border" />
              </div>
            ))}

            {/* Coin markers */}
            {coins.map((coin, i) => {
              const pct = ((timestamps[i] - minTs) / range) * 100;
              const cause = CAUSE_META[coin.causeOfDeath];
              const borderColor = CAUSE_BORDER[coin.causeOfDeath] ?? "border-zinc-500";
              const isActive = hovered?.symbol === coin.symbol || tapped === coin.symbol;
              const logoUrl = coin.logo ? `/logos/cemetery/${coin.logo}` : undefined;

              return (
                <div
                  key={coin.symbol}
                  className="absolute -translate-x-1/2 flex flex-col items-center"
                  style={{ left: `${pct}%`, top: 18 }}
                  onMouseEnter={() => setHovered(coin)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => handleMarkerClick(coin.symbol)}
                >
                  {/* Vertical line to axis */}
                  <div className="w-px h-[32px] bg-border/50" />

                  {/* Logo or letter fallback */}
                  <div
                    className={`relative flex items-center justify-center rounded-full border-2 bg-background cursor-default transition-transform overflow-hidden ${borderColor} ${
                      isActive ? "scale-125 z-20" : "z-10"
                    }`}
                    style={{ width: 28, height: 28 }}
                  >
                    {logoUrl ? (
                      <Image
                        src={logoUrl}
                        alt={coin.symbol}
                        width={24}
                        height={24}
                        className="rounded-full"
                        unoptimized
                      />
                    ) : (
                      <span className="text-[10px] font-bold text-muted-foreground">
                        {coin.symbol.charAt(0)}
                      </span>
                    )}
                  </div>

                  {/* Tooltip */}
                  {isActive && (
                    <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-30 whitespace-nowrap rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
                      <span className="font-semibold">{coin.name}</span>
                      <span className="text-muted-foreground"> ({coin.symbol})</span>
                      <span className="text-muted-foreground"> · {formatDeathDateShort(coin.deathDate)}</span>
                      {coin.peakMcap && (
                        <span className="text-muted-foreground"> · peak {formatCurrency(coin.peakMcap, 1)}</span>
                      )}
                      <br />
                      <span className={cause.textColor}>{cause.label}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 pt-2 border-t">
          {Object.entries(CAUSE_META).map(([key, meta]) => (
            <div key={key} className="flex items-center gap-1.5">
              <div className={`h-2.5 w-2.5 rounded-full border-2 ${CAUSE_BORDER[key]}`} />
              <span className="text-xs text-muted-foreground">{meta.label}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
