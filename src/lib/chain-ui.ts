import { getNetColor } from "@shared/lib/format";

/** Health band presentation is owned by `shared/lib/classification/chain-health.ts` (one authority with the Worker). */
export {
  CHAIN_HEALTH_BADGE_CLASSES as HEALTH_BADGE_CLASSES,
  CHAIN_HEALTH_TEXT_CLASSES as HEALTH_TEXT_CLASSES,
  CHAIN_HEALTH_FILL_CLASSES as HEALTH_FILL_CLASSES,
} from "@shared/lib/classification";

export function trendColor(value: number | null): string {
  if (value == null) return "text-muted-foreground";
  return getNetColor(value, {
    positiveClass: "text-emerald-600 dark:text-emerald-400",
    negativeClass: "text-red-600 dark:text-red-400",
    zeroClass: "text-emerald-600 dark:text-emerald-400",
    positiveInclusiveZero: true,
  });
}
