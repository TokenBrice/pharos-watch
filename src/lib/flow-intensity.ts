const FLOW_INTENSITY_NEUTRAL = 50;

/**
 * Convert backend 0..100 Flow Intensity Score into a signed -100..100 scale
 * where 0 is neutral, negative values indicate net burn pressure.
 */
export function toSignedFlowIntensity(intensity: number): number {
  return (intensity - FLOW_INTENSITY_NEUTRAL) * 2;
}

export function getSignedFlowIntensityDisplay(intensity: number): number {
  const rounded = Math.round(toSignedFlowIntensity(intensity));
  return rounded === 0 ? 0 : rounded;
}

export function getSignedFlowIntensityMagnitude(signedIntensity: number): number {
  return Math.min(100, Math.abs(signedIntensity));
}
