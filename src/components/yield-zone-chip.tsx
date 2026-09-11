import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { resolveYieldZone } from "@/lib/yield-scatter";
import { YIELD_ZONE_DESCRIPTIONS, YIELD_ZONE_LABELS, YIELD_ZONE_STYLES } from "@shared/lib/classification";

interface YieldZoneChipProps {
  safetyScore: number | null;
  apy30d: number;
  benchmarkRate: number | null | undefined;
  className?: string;
}

/**
 * Row-level echo of the scatter-plot quadrant. Sits beside the yield-type
 * badge so a top-PYS D-grade row reads "Danger Zone" on the same line as its
 * score instead of looking like a recommendation.
 */
export function YieldZoneChip({ safetyScore, apy30d, benchmarkRate, className }: YieldZoneChipProps) {
  const zone = resolveYieldZone(safetyScore, apy30d, benchmarkRate);
  if (zone === null) return null;
  return (
    <Badge
      variant="outline"
      title={YIELD_ZONE_DESCRIPTIONS[zone]}
      aria-label={`${YIELD_ZONE_LABELS[zone]}: ${YIELD_ZONE_DESCRIPTIONS[zone]}`}
      className={cn("cursor-help text-[10px]", YIELD_ZONE_STYLES[zone].badge, className)}
    >
      {YIELD_ZONE_LABELS[zone]}
    </Badge>
  );
}
