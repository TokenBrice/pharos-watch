"use client";

import { useDepegEvents } from "@/hooks/use-depeg-events";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration, formatNativePrice, formatEventDate, formatBps } from "@/lib/format";
import { deviationColorClass } from "@/lib/severity-colors";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { computePegStability } from "@/lib/peg-stability";
import type { DepegEvent } from "@/lib/types";

function sortEvents(events: DepegEvent[]): DepegEvent[] {
  return [...events].sort((a, b) => {
    // Ongoing events first
    if (!a.endedAt && b.endedAt) return -1;
    if (a.endedAt && !b.endedAt) return 1;
    // Then by start date descending
    return b.startedAt - a.startedAt;
  });
}

export function DepegHistory({ stablecoinId, earliestTrackingDate, hasPriceData = true }: { stablecoinId: string; earliestTrackingDate?: string | null; hasPriceData?: boolean }) {
  const { data, isLoading } = useDepegEvents(stablecoinId);
  const meta = TRACKED_STABLECOINS.find((s) => s.id === stablecoinId);
  const pegCurrency = meta?.flags.pegCurrency ?? "USD";

  if (isLoading) {
    return <Skeleton className="h-40" />;
  }

  const events = data?.events;
  if (!events || events.length === 0) {
    const noData = !hasPriceData;
    return (
      <Card className={`rounded-xl ${noData ? "" : "border-l-[3px] border-l-emerald-500"}`}>
        <CardHeader className="pb-1">
          <CardTitle as="h2" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Depeg History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {noData ? (
            <p className="text-sm text-muted-foreground">No depeg events recorded. No price data available to verify peg status.</p>
          ) : (
            <p className="text-sm text-emerald-500 font-medium">No depeg events recorded. This stablecoin has maintained its peg.</p>
          )}
        </CardContent>
      </Card>
    );
  }

  const sorted = sortEvents(events);
  const metrics = computePegStability(events, earliestTrackingDate ?? null);

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-1">
        <CardTitle as="h2" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Depeg History
        </CardTitle>
      </CardHeader>
      <CardContent>
        {metrics && (
          <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Events </span>
              <span className="font-mono font-semibold">{metrics.eventCount}</span>
            </div>
            {metrics.worstDeviationBps !== null && (
              <div>
                <span className="text-muted-foreground">Worst Depeg </span>
                <span className={`font-mono font-semibold ${deviationColorClass(Math.abs(metrics.worstDeviationBps))}`}>
                  {formatBps(metrics.worstDeviationBps)}
                </span>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Current Streak </span>
              {metrics.depeggedNow ? (
                <span className="inline-flex items-center gap-1.5 font-semibold text-red-500">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                  </span>
                  Depegged now
                </span>
              ) : metrics.currentStreakDays !== null ? (
                <span className="font-mono font-semibold text-emerald-500">{metrics.currentStreakDays}d at peg</span>
              ) : (
                <span className="font-mono font-semibold text-muted-foreground">N/A</span>
              )}
            </div>
          </div>
        )}
        <div className="overflow-x-auto scroll-shadow">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead className="text-right">Peak Deviation</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Start Price</TableHead>
                <TableHead className="text-right">Peak Price</TableHead>
                <TableHead className="text-right">Recovery Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((event) => (
                <DepegRow key={event.id} event={event} pegCurrency={pegCurrency} />
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function DepegRow({ event, pegCurrency }: { event: DepegEvent; pegCurrency: string }) {
  const isOngoing = event.endedAt === null;
  const absBps = Math.abs(event.peakDeviationBps);
  const devColor = deviationColorClass(absBps);

  return (
    <TableRow>
      <TableCell className="font-mono text-sm">
        {formatEventDate(event.startedAt)}
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={
            event.direction === "below"
              ? "bg-red-500/15 text-red-600 border-red-500/30 dark:text-red-400"
              : "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400"
          }
        >
          {event.direction === "below" ? "Below" : "Above"}
        </Badge>
      </TableCell>
      <TableCell className={`text-right font-mono ${devColor}`}>
        {event.peakDeviationBps > 0 ? "+" : ""}
        {event.peakDeviationBps} bps
      </TableCell>
      <TableCell className="text-right font-mono text-sm">
        {isOngoing ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            Ongoing
          </span>
        ) : (
          formatDuration(event.startedAt, event.endedAt)
        )}
      </TableCell>
      <TableCell className="text-right font-mono text-sm">
        {formatNativePrice(event.startPrice, pegCurrency, event.pegReference)}
      </TableCell>
      <TableCell className="text-right font-mono text-sm">
        {event.peakPrice != null ? formatNativePrice(event.peakPrice, pegCurrency, event.pegReference) : "—"}
      </TableCell>
      <TableCell className="text-right font-mono text-sm">
        {event.recoveryPrice != null ? formatNativePrice(event.recoveryPrice, pegCurrency, event.pegReference) : "—"}
      </TableCell>
    </TableRow>
  );
}
