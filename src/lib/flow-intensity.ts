function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const FLOW_INTENSITY_LEGACY_NEUTRAL = 50;

export type FlowIntensitySemantics = "midpoint-v1" | "signed-v2";

/**
 * Normalize signed flow intensity for display.
 * Backend contract is canonical signed range [-100, 100].
 */
export function getFlowIntensityDisplay(intensity: number): number {
  const rounded = Math.round(clamp(intensity, -100, 100));
  return rounded === 0 ? 0 : rounded;
}

export function getFlowIntensityMagnitude(signedIntensity: number): number {
  return Math.min(100, Math.abs(signedIntensity));
}

/**
 * Compatibility normalizer:
 * - `midpoint-v1`: converts 0..100 midpoint scale to signed -100..100.
 * - `signed-v2`: keeps signed value unchanged.
 */
export function normalizeToSignedFlowIntensity(
  intensity: number,
  semantics: FlowIntensitySemantics,
): number {
  if (semantics === "midpoint-v1") {
    return clamp((intensity - FLOW_INTENSITY_LEGACY_NEUTRAL) * 2, -100, 100);
  }
  return clamp(intensity, -100, 100);
}
