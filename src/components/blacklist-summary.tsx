"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ShieldBan } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { useBlacklistEvents } from "@/hooks/use-blacklist-events";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { extractGoldPrices, computeBlacklistStats } from "@/lib/blacklist-helpers";

export function BlacklistSummary() {
  const { data, isLoading } = useBlacklistEvents();
  const events = data?.events;
  const { data: stablecoins } = useStablecoins();

  const goldPrices = useMemo(() => {
    if (!stablecoins) return {};
    return extractGoldPrices(stablecoins.peggedAssets);
  }, [stablecoins]);

  const stats = useMemo(() => {
    if (!events) return null;
    return computeBlacklistStats(events, goldPrices);
  }, [events, goldPrices]);

  if (isLoading) {
    return (
      <Card className="rounded-xl border-l-[3px] border-l-red-500">
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl border-l-[3px] border-l-red-500">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="flex items-center justify-between">
          <span className="flex items-center gap-1.5"><ShieldBan className="h-4 w-4" />Blacklist Activity</span>
          <Link
            href="/blacklist"
            className="text-xs font-normal text-muted-foreground hover:text-foreground transition-colors"
          >
            View all events &rarr;
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-live="polite">
          <div>
            <p className="text-2xl font-bold font-mono">{stats?.frozenAddresses ?? 0}</p>
            <p className="text-xs text-muted-foreground">frozen addresses</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono">{stats ? formatCurrency(stats.destroyedTotal) : "$0"}</p>
            <p className="text-xs text-muted-foreground">destroyed value</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono">{stats?.recentCount ?? 0}</p>
            <p className="text-xs text-muted-foreground">events (30d)</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
