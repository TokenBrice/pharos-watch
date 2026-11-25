import { COVERAGE_UNAVAILABLE_BADGE_CLASS } from "@shared/lib/classification";
import { type CoverageStatus, type CoverageTone, COVERAGE_BADGE_TONE_CLASS } from "@/lib/coverage";
import { cn } from "@/lib/utils";
import { getPricingSourceLabel } from "@shared/lib/pricing-sources";

function buildSourceTooltip(status: CoverageStatus): string {
  if (!status.sourceNames?.length) return status.detail;

  const confidenceLabel = status.priceConfidence
    ? `${status.priceConfidence.charAt(0).toUpperCase()}${status.priceConfidence.slice(1).replace("-", " ")} confidence`
    : "";
  const sourceList = status.sourceNames.map((s) => getPricingSourceLabel(s)).join(", ");

  return confidenceLabel ? `${confidenceLabel} — ${sourceList}` : sourceList;
}

const TONE_INDICATOR: Record<CoverageTone, string> = {
  emerald: "\u2713",
  sky: "\u25CB",
  amber: "\u25B3",
  violet: "\u25C7",
  rose: "\u25C6",
  slate: "\u2013",
};

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
  const tooltip = buildSourceTooltip(status);
  const ariaLabel = `${status.spokenLabel}${countSuffix}. ${tooltip}`;
  const isUnavailableOrChecking =
    status.kind === "data-unavailable" || status.kind === "checking";
  const isQuietCompactSlate =
    compact && !isUnavailableOrChecking && status.tone === "slate";

  return (
    <span
      title={tooltip}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap text-2xs font-medium",
        isQuietCompactSlate
          ? "min-w-[3.75rem] px-1.5 py-0.5 text-muted-foreground/75"
          : cn(
              "border",
              compact
                ? "min-w-[3.75rem] rounded-sm px-1.5 py-0.5"
                : "min-w-[5rem] rounded-full px-2 py-1",
              isUnavailableOrChecking
                ? COVERAGE_UNAVAILABLE_BADGE_CLASS
                : COVERAGE_BADGE_TONE_CLASS[status.tone],
            ),
      )}
    >
      <span aria-hidden="true">
        <span className="text-3xs mr-0.5 opacity-70" aria-hidden="true">
          {TONE_INDICATOR[status.tone]}
        </span>
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
