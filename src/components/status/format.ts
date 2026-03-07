import { DAY_SECONDS, HOUR_SECONDS, SECONDS_PER_MINUTE } from "@/lib/constants";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatAge(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  if (seconds < HOUR_SECONDS) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  if (seconds < DAY_SECONDS) {
    return `${Math.floor(seconds / HOUR_SECONDS)}h ${Math.floor((seconds % HOUR_SECONDS) / SECONDS_PER_MINUTE)}m`;
  }
  return `${Math.floor(seconds / DAY_SECONDS)}d`;
}

export function formatInterval(seconds: number): string {
  if (seconds < HOUR_SECONDS) return `${seconds / SECONDS_PER_MINUTE}min`;
  return `${seconds / HOUR_SECONDS}h`;
}
