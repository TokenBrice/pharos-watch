import { cn } from "@/lib/utils";
import type { YieldCohortPercentile } from "@/lib/yield-view-model";

interface YieldCohortChipProps {
  cohort: YieldCohortPercentile | null | undefined;
  className?: string;
}

export function YieldCohortChip({ cohort, className }: YieldCohortChipProps) {
  if (cohort == null) return null;
  if (cohort.value === null) {
    return (
      <span
        title="Cohort smaller than 8 peers"
        className={cn("text-[10px] text-muted-foreground tabular-nums", className)}
      >
        small peer set
      </span>
    );
  }
  return (
    <span
      title={`Percentile ${cohort.value} in ${cohort.cohortSize} peers`}
      className={cn("text-[10px] text-muted-foreground tabular-nums", className)}
    >
      p{cohort.value} of {cohort.cohortSize}
    </span>
  );
}
