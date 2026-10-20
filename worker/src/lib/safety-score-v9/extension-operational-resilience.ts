import operationalResilienceOverlaysAsset from "@shared/data/safety-score-v9/operational-resilience-overlays-v1.json";
import {
  SafetyScoreV9OperationalResilienceOverlaySchema,
  SafetyScoreV9OperationalResilienceOverlayEnvelopeSchema,
  type SafetyScoreV9OperationalResilienceOverlay,
} from "@shared/types/safety-score-v9-operational-resilience-overlays";
import { createReviewedAssetRegistry, reviewedRegistryEnvelopeDigest } from "@shared/lib/safety-score-v9/reviewed-registry";


const OPERATIONAL_RESILIENCE_OVERLAY_FILE = SafetyScoreV9OperationalResilienceOverlayEnvelopeSchema.parse(
  operationalResilienceOverlaysAsset,
);

export const SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST = reviewedRegistryEnvelopeDigest("safety-score-v9.operational-resilience-overlays.v1", "payload", OPERATIONAL_RESILIENCE_OVERLAY_FILE);

const SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS = createReviewedAssetRegistry({
  rows: OPERATIONAL_RESILIENCE_OVERLAY_FILE.overlays,
  schema: SafetyScoreV9OperationalResilienceOverlaySchema,
  path: "operationalResilience.overlays",
});

export function getSafetyScoreV9OperationalResilienceOverlay(
  assetId: string,
  clockSec: number,
): SafetyScoreV9OperationalResilienceOverlay | null {
  if (!Number.isFinite(clockSec) || clockSec < 0) {
    throw new Error("Safety Score v9 operational-resilience clock must be finite and non-negative");
  }
  const overlay = SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS.get(assetId);
  if (!overlay) return null;
  const clockMs = clockSec * 1_000;
  return Date.parse(overlay.reviewedAt) <= clockMs && clockMs < Date.parse(overlay.expiresAt) ? overlay : null;
}
