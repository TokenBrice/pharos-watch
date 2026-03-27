import {
  type CoverageStatus,
  COVERAGE_BADGE_TONE_CLASS,
} from "@/lib/coverage";
import { cn } from "@/lib/utils";
import { getPricingSourceLabel } from "@shared/lib/pricing-sources";

function buildSourceTooltip(status: CoverageStatus): string {
  if (!status.sourceNames?.length) return status.detail;

  const confidenceLabel = status.priceConfidence
    ? `${status.priceConfidence.charAt(0).toUpperCase()}${status.priceConfidence.slice(1).replace("-", " ")} confidence`
    : "";
  const sourceList = status.sourceNames
    .map((s) => getPricingSourceLabel(s))
    .join(", ");

  return confidenceLabel
    ? `${confidenceLabel} — ${sourceList}`
    : sourceList;
}

export interface CoverageBadgeProps {
  status: CoverageStatus;
  compact?: boolean;
}

export function CoverageBadge({ status, compact = false }: CoverageBadgeProps) {
  const countSuffix =
    status.sourceCount != null && status.sourceCount > 0
      ? compact
        ? ` (${status.sourceCount})`
        : ` (${status.sourceCount} sources)`
      : "";

  return (
    <span
      title={buildSourceTooltip(status)}
      className={cn(
        "inline-flex items-center justify-center rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-[0.01em]",
        compact ? "min-w-[4.25rem]" : "min-w-[4.75rem]",
        COVERAGE_BADGE_TONE_CLASS[status.tone],
      )}
    >
      <span aria-hidden="true">
        {status.label}
        {countSuffix}
      </span>
      <span className="sr-only">
        {status.spokenLabel}
        {countSuffix}
      </span>
    </span>
  );
}
