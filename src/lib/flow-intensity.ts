import { clamp } from "@shared/lib/math";

/**
 * Round the canonical signed baseline-relative pressure shift for display.
 * Backend contract is canonical signed range [-100, 100].
 */
export function getPressureShiftDisplay(intensity: number): number {
  const rounded = Math.round(clamp(intensity, -100, 100));
  return rounded === 0 ? 0 : rounded;
}
