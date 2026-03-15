import { HOUR_SECONDS, SECONDS_PER_MINUTE } from "@/lib/constants";

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatInterval(seconds: number): string {
  if (seconds < HOUR_SECONDS) return `${seconds / SECONDS_PER_MINUTE}min`;
  return `${seconds / HOUR_SECONDS}h`;
}
