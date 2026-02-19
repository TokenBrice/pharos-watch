/**
 * Shared deviation severity color mapping.
 *
 * Thresholds (absolute basis points):
 *   < GREEN  green  (healthy)
 *   GREEN-AMBER  amber  (mild)
 *   AMBER-ORANGE orange (moderate)
 *   >= ORANGE  red    (severe)
 */

const THRESHOLDS = { GREEN: 50, AMBER: 200, ORANGE: 500 } as const;

export function deviationColorClass(absBps: number): string {
  if (absBps < THRESHOLDS.GREEN) return "text-green-500";
  if (absBps < THRESHOLDS.AMBER) return "text-amber-500";
  if (absBps < THRESHOLDS.ORANGE) return "text-orange-500";
  return "text-red-500";
}

export function deviationBgClass(absBps: number): string {
  if (absBps < THRESHOLDS.GREEN) return "bg-green-500";
  if (absBps < THRESHOLDS.AMBER) return "bg-amber-500";
  if (absBps < THRESHOLDS.ORANGE) return "bg-orange-500";
  return "bg-red-500";
}

export function deviationColorHex(absBps: number): string {
  if (absBps < THRESHOLDS.GREEN) return "#22c55e";
  if (absBps < THRESHOLDS.AMBER) return "#f59e0b";
  if (absBps < THRESHOLDS.ORANGE) return "#f97316";
  return "#ef4444";
}
