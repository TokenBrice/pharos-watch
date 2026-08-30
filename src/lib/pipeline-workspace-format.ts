import { formatElapsedSeconds } from "@shared/lib/format";

export function formatAge(ageSeconds: number | null, suffix = "since last sample"): string {
  if (ageSeconds == null) return "Last sample not reported";
  return `${formatElapsedSeconds(ageSeconds)} ${suffix}`;
}
