import { HOUR_SECONDS, SECONDS_PER_MINUTE } from "@/lib/constants";

export function formatInterval(seconds: number): string {
  if (seconds < HOUR_SECONDS) return `${seconds / SECONDS_PER_MINUTE}min`;
  return `${seconds / HOUR_SECONDS}h`;
}
