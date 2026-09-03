import operationalResilienceOverlaysAsset from "@shared/data/safety-score-v9/operational-resilience-overlays-v1.json";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SafetyScoreV9OperationalResilienceOverlaySchema,
  SafetyScoreV9OperationalResilienceOverlayFileSchema,
  type SafetyScoreV9OperationalResilienceOverlay,
} from "@shared/types/safety-score-v9-operational-resilience-overlays";

export {
  SafetyScoreV9OperationalResilienceOverlaySchema,
  SafetyScoreV9OperationalResilienceOverlayFileSchema,
};
export type { SafetyScoreV9OperationalResilienceOverlay };

const OPERATIONAL_RESILIENCE_OVERLAY_FILE = SafetyScoreV9OperationalResilienceOverlayFileSchema.parse(
  operationalResilienceOverlaysAsset,
);

export const SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST = sha256Hex(
  stableJsonStringifyV1({
    domain: "safety-score-v9.operational-resilience-overlays.v1",
    payload: OPERATIONAL_RESILIENCE_OVERLAY_FILE,
  }),
);

const SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS: ReadonlyMap<
  string,
  SafetyScoreV9OperationalResilienceOverlay
> = new Map(OPERATIONAL_RESILIENCE_OVERLAY_FILE.overlays.map((overlay) => [overlay.assetId, overlay]));

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

export function getSafetyScoreV9OperationalResilienceOverlayEvidence(
  assetId: string,
  clockSec: number,
): {
  reviewedAt: string;
  expiresAt: string;
  sources: SafetyScoreV9OperationalResilienceOverlay["sources"];
  payload: SafetyScoreV9OperationalResilienceOverlay;
  payloadSha256: string;
} | null {
  const overlay = getSafetyScoreV9OperationalResilienceOverlay(assetId, clockSec);
  return overlay
    ? {
        reviewedAt: overlay.reviewedAt,
        expiresAt: overlay.expiresAt,
        sources: overlay.sources,
        payload: overlay,
        payloadSha256: SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST,
      }
    : null;
}
