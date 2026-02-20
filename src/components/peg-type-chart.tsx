"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { PEG_CHART_COLORS as PEG_META } from "@/lib/classification";
import { getCirculatingRaw } from "@/lib/supply";
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import type { StablecoinData } from "@/lib/types";

interface AltPegDominanceProps {
  data: StablecoinData[] | undefined;
}

export function PegTypeChart({ data }: AltPegDominanceProps) {
  const stats = useMemo(() => {
    if (!data) return null;

    const trackedIds = TRACKED_IDS;
    const metaById = TRACKED_META_BY_ID;

    // Group market caps by peg currency (excluding USD)
    const pegTotals: Record<string, number> = {};
    let altTotal = 0;

    for (const coin of data) {
      if (!trackedIds.has(coin.id)) continue;
      const meta = metaById.get(coin.id);
      if (!meta || meta.flags.pegCurrency === "USD") continue;

      const mcap = getCirculatingRaw(coin);
      const peg = meta.flags.pegCurrency;
      pegTotals[peg] = (pegTotals[peg] ?? 0) + mcap;
      altTotal += mcap;
    }

    // Sort by mcap descending, take top 3
    const sorted = Object.entries(pegTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    return { categories: sorted, altTotal };
  }, [data]);

  if (!stats || stats.altTotal === 0) return null;

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle as="h2">Non-USD-Pegged Stablecoin Dominance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats.categories.map(([peg, mcap]) => {
          const dominance = (mcap / stats.altTotal) * 100;
          const meta = PEG_META[peg] ?? { label: peg, textColor: "text-muted-foreground", bgColor: "bg-muted-foreground" };
          return (
            <div key={peg} className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className={`text-sm font-medium ${meta.textColor}`}>
                  {meta.label}
                </span>
                <span className="text-2xl font-bold font-mono">{dominance.toFixed(1)}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${meta.bgColor}`}
                  style={{ width: `${dominance}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground font-mono">{formatCurrency(mcap)}</p>
            </div>
          );
        })}
        <div className="pt-2 border-t">
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>Total non-USD</span>
            <span className="font-mono">{formatCurrency(stats.altTotal)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
