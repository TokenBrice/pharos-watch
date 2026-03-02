"use client";

import Link from "next/link";
import { Skull } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { DEAD_STABLECOINS, CAUSE_META } from "@/lib/dead-stablecoins";
import type { CauseOfDeath } from "@/lib/types";

export function CemeterySummary() {
  let totalDestroyed = 0;
  const byCause = new Map<CauseOfDeath, number>();

  for (const coin of DEAD_STABLECOINS) {
    if (coin.peakMcap) totalDestroyed += coin.peakMcap;
    byCause.set(coin.causeOfDeath, (byCause.get(coin.causeOfDeath) ?? 0) + 1);
  }

  const topCauses = Array.from(byCause.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  return (
    <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="flex items-center justify-between">
          <span className="flex items-center gap-1.5"><Skull className="h-4 w-4" />Stablecoin Cemetery</span>
          <Link
            href="/cemetery"
            className="text-xs font-normal text-muted-foreground hover:text-foreground transition-colors"
          >
            View all &rarr;
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-2xl font-extrabold font-mono tabular-nums">{DEAD_STABLECOINS.length}</p>
            <p className="text-xs text-muted-foreground">dead stablecoins</p>
          </div>
          <div>
            <p className="text-2xl font-extrabold font-mono tabular-nums">{formatCurrency(totalDestroyed, 1)}</p>
            <p className="text-xs text-muted-foreground">peak value destroyed</p>
          </div>
          <div className="space-y-1">
            {topCauses.map(([cause, count]) => (
              <div key={cause} className="flex items-center justify-between text-xs">
                <span className={CAUSE_META[cause].textColor}>{CAUSE_META[cause].label}</span>
                <span className="font-mono font-semibold">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
