import { CircleCheck, TriangleAlert, OctagonAlert, CircleX } from "lucide-react";
import { deviationIconName, type SeverityIcon } from "@/lib/severity-colors";

const ICON_MAP: Record<SeverityIcon, typeof CircleCheck> = {
  CircleCheck,
  TriangleAlert,
  OctagonAlert,
  CircleX,
};

/**
 * Tiny severity icon sized for inline use next to peg deviation numbers.
 * Maps deviation (absolute bps) to a Lucide icon:
 *   <50bps  → CircleCheck (green)
 *   50-200  → TriangleAlert (amber)
 *   200-500 → OctagonAlert (orange)
 *   >500    → CircleX (red)
 */
export function DeviationIcon({ absBps, className = "h-3 w-3" }: { absBps: number; className?: string }) {
  const name = deviationIconName(absBps);
  const Icon = ICON_MAP[name];
  return <Icon className={className} aria-hidden="true" />;
}
