"use client";

import { useLiveWatcherCountDisplay } from "./live-watcher-count";
import { TELEGRAM_METRIC_SEMANTICS } from "@shared/lib/telegram-metrics";

export function NightShiftMetric() {
  const display = useLiveWatcherCountDisplay();

  if (display == null) return null;

  return (
    <p className="mt-10 flex items-baseline gap-2.5" title={TELEGRAM_METRIC_SEMANTICS.activeWatchers.description}>
      <span aria-hidden="true" className="relative flex h-2 w-2 self-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-[var(--brand-accent)]/70 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand-accent)]" />
      </span>
      <span className="pharos-numeric text-[1.75rem] font-semibold leading-none tracking-tight text-frost-blue">
        {display}
      </span>
      <span className="text-sm text-muted-foreground">active watchers</span>
    </p>
  );
}
