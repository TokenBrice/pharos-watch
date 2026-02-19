/**
 * Shared deviation severity color mapping.
 *
 * Thresholds (absolute basis points):
 *   < 50   green  (healthy)
 *   50-199  amber  (mild)
 *   200-499 orange (moderate)
 *   >= 500  red    (severe)
 */

/**
 * Returns Tailwind CSS classes for deviation severity coloring.
 * For use in className props on React elements.
 */
export function deviationColorClass(absBps: number): string {
  if (absBps < 50) return "text-green-500";
  if (absBps < 200) return "text-amber-500";
  if (absBps < 500) return "text-orange-500";
  return "text-red-500";
}

/**
 * Returns Tailwind CSS bg classes for deviation severity.
 */
export function deviationBgClass(absBps: number): string {
  if (absBps < 50) return "bg-green-500";
  if (absBps < 200) return "bg-amber-500";
  if (absBps < 500) return "bg-orange-500";
  return "bg-red-500";
}

/**
 * Returns hex color string for deviation severity.
 * For use in SVG fills, Recharts, or other non-className contexts.
 */
export function deviationColorHex(absBps: number): string {
  if (absBps < 50) return "#22c55e";
  if (absBps < 200) return "#f59e0b";
  if (absBps < 500) return "#f97316";
  return "#ef4444";
}
