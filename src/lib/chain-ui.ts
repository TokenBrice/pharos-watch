import { DIRECTION_TONE_CLASSES } from "@shared/lib/classification";
import { WAKE_HUE_PCT } from "@shared/lib/harbor-scene";
import { roundForDisplay } from "@shared/lib/format";

export { formatChainShare } from "@shared/lib/chain-share-format";

/** Health band presentation is owned by `shared/lib/classification/chain-health.ts` (one authority with the Worker). */
export {
  CHAIN_HEALTH_BADGE_CLASSES as HEALTH_BADGE_CLASSES,
  CHAIN_HEALTH_TEXT_CLASSES as HEALTH_TEXT_CLASSES,
  CHAIN_HEALTH_FILL_CLASSES as HEALTH_FILL_CLASSES,
} from "@shared/lib/classification";

/**
 * Tint for a chain's 7d supply change ratio. Harbor's 7d wake owns the threshold (`WAKE_HUE_PCT`): moves smaller than
 * it, including a measured 0.00%, stay neutral ink, so the leaderboard, profile and scene agree on what is "moving".
 * Other windows and per-coin changes are not the wake's quantity; they use `deltaColor`.
 */
export function trendColor(value: number | null): string {
  if (value == null) return "text-muted-foreground";
  const pct = value * 100;
  if (Math.abs(pct) < WAKE_HUE_PCT) return "text-foreground";
  return pct > 0 ? DIRECTION_TONE_CLASSES.up : DIRECTION_TONE_CLASSES.down;
}

/** Tint for any other change ratio (24h/30d, per-coin rows): direction only, with a measured or rounded zero in neutral ink. */
export function deltaColor(value: number | null): string {
  if (value == null) return "text-muted-foreground";
  // Callers print percentage points at two decimals; a rounded zero is neutral ink.
  if (roundForDisplay(value * 100, 2) === 0) return "text-foreground";
  return value > 0 ? DIRECTION_TONE_CLASSES.up : DIRECTION_TONE_CLASSES.down;
}
