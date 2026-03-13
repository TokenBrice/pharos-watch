import { HOUR_SECONDS, SECONDS_PER_MINUTE } from "@/lib/constants";
import { formatElapsedSeconds } from "@shared/lib/format";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatAge(seconds: number): string {
  return formatElapsedSeconds(seconds);
}

export function formatInterval(seconds: number): string {
  if (seconds < HOUR_SECONDS) return `${seconds / SECONDS_PER_MINUTE}min`;
  return `${seconds / HOUR_SECONDS}h`;
}
