import mechanismReviewOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import {
  SafetyScoreV9MechanismReviewOverlayFileSchema,
  type SafetyScoreV9MechanismReviewOverlay,
} from "@shared/types/safety-score-v9-mechanism-overlays";

/**
 * Server-only index for the reviewed mechanism overlay. Keep this module out
 * of client components: the checked-in source file is roughly 1 MB, while the
 * view builders pass only their small projections across the server boundary.
 */
const mechanismOverlayFile = SafetyScoreV9MechanismReviewOverlayFileSchema.parse(mechanismReviewOverlays);

const MECHANISM_REVIEW_OVERLAYS_BY_ASSET_ID: ReadonlyMap<string, SafetyScoreV9MechanismReviewOverlay> = new Map(
  mechanismOverlayFile.overlays.map((overlay) => [overlay.assetId, overlay]),
);

export type MechanismOverlayEntry = SafetyScoreV9MechanismReviewOverlay;

export function getMechanismReviewOverlay(assetId: string): MechanismOverlayEntry | null {
  return MECHANISM_REVIEW_OVERLAYS_BY_ASSET_ID.get(assetId) ?? null;
}
