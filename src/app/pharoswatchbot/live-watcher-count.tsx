"use client";

import { useCountUp } from "@/hooks/use-count-up";
import { useTelegramPulse } from "@/hooks/api-hooks";
import { TELEGRAM_PULSE_STATIC } from "@/lib/telegram-pulse-static";

export function useLiveWatcherCountDisplay(): string | null {
  const { data } = useTelegramPulse();
  const target = data?.activeWatchers ?? TELEGRAM_PULSE_STATIC.activeWatchers;
  return useCountUp(target).display;
}

export function LiveWatcherCount() {
  const display = useLiveWatcherCountDisplay();
  return <span className="pharos-numeric font-semibold text-frost-blue">{display ?? "—"}</span>;
}
