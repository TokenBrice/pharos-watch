"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useTelegramPulse } from "@/hooks/use-telegram-pulse";
import { TELEGRAM_METRIC_SEMANTICS } from "@shared/lib/telegram-metrics";

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

/**
 * The hero's single live figure: active watchers from the same public pulse
 * contract as the adoption board below. Hidden entirely when telemetry is
 * unavailable; the signal board stands alone.
 */
export function TelegramHeroMetric() {
  const { data, isLoading } = useTelegramPulse();

  if (isLoading) {
    return <Skeleton className="h-5 w-36" aria-hidden="true" />;
  }
  if (!data) return null;

  return (
    <p className="flex items-baseline gap-2" title={TELEGRAM_METRIC_SEMANTICS.activeWatchers.description}>
      <span aria-hidden="true" className="relative flex h-2 w-2 self-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-[var(--brand-accent)]/70 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand-accent)]" />
      </span>
      <span className="pharos-numeric text-xl font-semibold leading-none tracking-tight text-frost-blue">
        {NUMBER_FORMATTER.format(data.activeWatchers)}
      </span>
      <span className="text-xs text-muted-foreground">active watchers</span>
    </p>
  );
}
