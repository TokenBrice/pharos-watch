import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { getSafetyGradeBadgeClassName } from "@/lib/report-card-ui";
import { cn } from "@/lib/utils";
import type { ReportCardGrade } from "@shared/types";

type SafetyGradeBadgeSize = "xs" | "sm" | "md" | "lg" | "defunct" | "hero";

const SIZE_CLASSES: Record<SafetyGradeBadgeSize, string> = {
  xs: "px-2 py-0.5 text-xs font-medium",
  sm: "px-2 py-0.5 text-xs font-semibold",
  md: "px-2 py-0.5 font-mono text-base font-bold",
  lg: "px-3 py-1 font-mono text-xl font-bold",
  defunct: "px-4 py-2 text-2xl font-bold",
  hero: "px-7 py-3 text-5xl font-extrabold tracking-tight shadow-lg",
};

interface SafetyGradeBadgeProps extends Omit<ComponentProps<typeof Badge>, "children" | "variant"> {
  grade: ReportCardGrade;
  score?: number | null;
  showScore?: boolean;
  size?: SafetyGradeBadgeSize;
  animate?: boolean;
  animationDelayMs?: number;
}

export function SafetyGradeBadge({
  grade,
  score = null,
  showScore = score !== null,
  size = "sm",
  animate = false,
  animationDelayMs,
  className,
  style,
  "aria-label": ariaLabel,
  ...props
}: SafetyGradeBadgeProps) {
  const scoreLabel = showScore && score !== null ? `, score ${score}` : "";
  const mergedStyle = animationDelayMs == null
    ? style
    : { ...style, animationDelay: `${animationDelayMs}ms` };

  return (
    <Badge
      variant="outline"
      className={cn(
        SIZE_CLASSES[size],
        animate && "pharos-grade-pop",
        getSafetyGradeBadgeClassName(grade),
        className,
      )}
      style={mergedStyle}
      aria-label={ariaLabel ?? `Safety grade ${grade}${scoreLabel}`}
      {...props}
    >
      {grade}
      {showScore && score !== null ? (
        <span className="ml-1 opacity-70" aria-hidden="true">
          ({score})
        </span>
      ) : null}
    </Badge>
  );
}
