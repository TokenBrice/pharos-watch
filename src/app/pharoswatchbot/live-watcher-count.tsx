"use client";

import { useCountUp } from "@/hooks/use-count-up";
import { useTelegramPulse } from "@/hooks/api-hooks";

export function isTelegramPulseAvailable(query: { data?: unknown; isLoading: boolean; isError: boolean }): boolean {
  return !query.isLoading && !query.isError && query.data != null;
}

export function useLiveWatcherCountDisplay(): string | null {
  const query = useTelegramPulse();
  const available = isTelegramPulseAvailable(query);
  const count = useCountUp(available ? query.data?.activeWatchers ?? null : null);
  // useCountUp preserves its last display on null; availability must gate the output too.
  return available && query.data?.activeWatchers != null ? count.display : null;
}

export function LiveWatcherCount() {
  const display = useLiveWatcherCountDisplay();
  return <span className="pharos-numeric font-semibold text-frost-blue">{display ?? "—"}</span>;
}
