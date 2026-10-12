import { getNetColor } from "@shared/lib/format";
import { DIRECTION_TONE_CLASSES } from "@shared/lib/classification";

/** Health band presentation is owned by `shared/lib/classification/chain-health.ts` (one authority with the Worker). */
export {
  CHAIN_HEALTH_BADGE_CLASSES as HEALTH_BADGE_CLASSES,
  CHAIN_HEALTH_TEXT_CLASSES as HEALTH_TEXT_CLASSES,
  CHAIN_HEALTH_FILL_CLASSES as HEALTH_FILL_CLASSES,
} from "@shared/lib/classification";

export function trendColor(value: number | null): string {
  if (value == null) return "text-muted-foreground";
  return getNetColor(value, {
    positiveClass: DIRECTION_TONE_CLASSES.up,
    negativeClass: DIRECTION_TONE_CLASSES.down,
    zeroClass: DIRECTION_TONE_CLASSES.up,
    positiveInclusiveZero: true,
  });
}
