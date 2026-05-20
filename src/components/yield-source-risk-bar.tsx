import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface YieldSourceRiskBarProps {
  score: number | null;
  compact?: boolean;
  tooltip?: boolean;
  className?: string;
}

const SEGMENTS = 5;

function clampScore(score: number): number {
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

function getSegmentClass(index: number, score: number): string {
  // 5 thresholds at 20, 40, 60, 80, 100
  const threshold = (index + 1) * (100 / SEGMENTS);
  if (score < threshold - 100 / SEGMENTS + 0.0001) {
    return "bg-muted/40";
  }
  // First two segments are emerald/sky, middle is amber, top two are amber/red.
  if (index <= 1) return "bg-emerald-500/40";
  if (index === 2) return "bg-amber-500/40";
  return "bg-red-500/40";
}

export function YieldSourceRiskBar({
  score,
  compact = false,
  tooltip = false,
  className,
}: YieldSourceRiskBarProps) {
  const widthClass = compact ? "w-[80px]" : "w-[120px]";
  const heightClass = compact ? "h-1" : "h-1.5";

  if (score == null || !Number.isFinite(score)) {
    const bar = (
      <div
        role="img"
        aria-label="Source-risk score unavailable"
        className={cn("flex gap-px overflow-hidden rounded-full bg-muted/30", widthClass, heightClass, className)}
      >
        <div className="h-full w-full animate-pulse bg-muted/30" />
      </div>
    );
    if (!tooltip) return bar;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{bar}</TooltipTrigger>
        <TooltipContent>Source-risk score unavailable</TooltipContent>
      </Tooltip>
    );
  }

  const clamped = clampScore(score);
  const bar = (
    <div
      role="img"
      aria-label={`Source-risk score: ${Math.round(clamped)} of 100`}
      className={cn("flex gap-px overflow-hidden rounded-full", widthClass, heightClass, className)}
    >
      {Array.from({ length: SEGMENTS }).map((_, index) => (
        <div key={index} className={cn("h-full flex-1", getSegmentClass(index, clamped))} />
      ))}
    </div>
  );

  if (!tooltip) return bar;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{bar}</TooltipTrigger>
      <TooltipContent>Source-risk score: {Math.round(clamped)} of 100</TooltipContent>
    </Tooltip>
  );
}

YieldSourceRiskBar.displayName = "YieldSourceRiskBar";
