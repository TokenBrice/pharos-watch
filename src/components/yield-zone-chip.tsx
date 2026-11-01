import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { resolveYieldZone } from "@/lib/yield-scatter";
import { YIELD_ZONE_DESCRIPTIONS, YIELD_ZONE_LABELS, YIELD_ZONE_STYLES } from "@shared/lib/classification";
import {
  isOpportunityDerivedSafety,
  YIELD_OPPORTUNITY_SAFETY_DESCRIPTION,
} from "@shared/lib/yield-opportunity-provenance";

interface YieldZoneChipProps {
  safetyScore: number | null;
  apy30d: number;
  /**
   * The row's *resolved* benchmark rate — pass
   * `resolveYieldRowBenchmark(row, registry, riskFreeRate).rate` so a missing
   * row rate resolves from the registry by benchmarkKey before the chart-wide
   * USD frame, and the chip disappears only when no benchmark resolves at all.
   */
  benchmarkRate: number | null | undefined;
  /** Published safety provenance; a default or opportunity grade is not the coin's own Safety Score. */
  safetyProvenance?: string | null;
  className?: string;
}

/**
 * Row-level echo of the scatter-plot quadrant. Sits beside the yield-type
 * badge so a top-PYS D-grade row reads "Danger Zone" on the same line as its
 * score instead of looking like a recommendation.
 */
export function YieldZoneChip({
  safetyScore,
  apy30d,
  benchmarkRate,
  safetyProvenance,
  className,
}: YieldZoneChipProps) {
  // A default-safety 40 is a stand-in for an unobserved score, so it cannot
  // place the row in a zone that reads as the coin's own verdict (R1).
  if (safetyProvenance === "default-safety") return null;
  const zone = resolveYieldZone(safetyScore, apy30d, benchmarkRate);
  if (zone === null) return null;
  const description = isOpportunityDerivedSafety(safetyProvenance)
    ? `${YIELD_ZONE_DESCRIPTIONS[zone]} ${YIELD_OPPORTUNITY_SAFETY_DESCRIPTION}`
    : YIELD_ZONE_DESCRIPTIONS[zone];
  return (
    <Badge
      variant="outline"
      title={description}
      aria-label={`${YIELD_ZONE_LABELS[zone]}: ${description}`}
      className={cn("cursor-help text-3xs", YIELD_ZONE_STYLES[zone].badge, className)}
    >
      {YIELD_ZONE_LABELS[zone]}
    </Badge>
  );
}
