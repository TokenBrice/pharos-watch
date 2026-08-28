"use client";

import { useCountUp } from "@/hooks/use-count-up";
import { useTelegramPulse } from "@/hooks/api-hooks";
import { TELEGRAM_PULSE_STATIC } from "@/lib/telegram-pulse-static";

/**
 * Inline live watcher count for the dawn proof row. Renders an em dash until
 * a real figure exists (live first, baked snapshot as bridge).
 */
export function LiveWatcherCount() {
  const { data } = useTelegramPulse();
  const target = data?.activeWatchers ?? TELEGRAM_PULSE_STATIC.activeWatchers;
  const { display } = useCountUp(target);
  return <span className="pharos-numeric font-semibold text-frost-blue">{display ?? "—"}</span>;
}
