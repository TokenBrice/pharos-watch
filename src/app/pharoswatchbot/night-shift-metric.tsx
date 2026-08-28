"use client";

import { useCountUp } from "@/hooks/use-count-up";
import { useTelegramPulse } from "@/hooks/api-hooks";
import { TELEGRAM_PULSE_STATIC } from "@/lib/telegram-pulse-static";
import { TELEGRAM_METRIC_SEMANTICS } from "@shared/lib/telegram-metrics";

/**
 * The hero's live adoption figure. Live pulse data wins; the baked static
 * snapshot bridges first paint; when neither exists the line stays quiet
 * rather than flashing a skeleton or an invented figure.
 */
export function NightShiftMetric() {
  const { data } = useTelegramPulse();
  const target = data?.activeWatchers ?? TELEGRAM_PULSE_STATIC.activeWatchers;
  const { display } = useCountUp(target);

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
