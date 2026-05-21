import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { ScoreBadgeWrapper, type ScoreBadgeWrapperVariant } from "@/components/score-badge-wrapper";
import { MethodologyLinkBadge } from "@/components/methodology-link-badge";
import { getSafetyGradeBadgeClassName } from "@/lib/report-card-ui";
import { cn } from "@/lib/utils";
import type { MethodologyContextKey } from "@/lib/methodology-context";
import type { ReportCardGrade } from "@shared/types";

type SafetyGradeBadgeSize = "xs" | "sm" | "md" | "lg" | "defunct" | "hero";

const SIZE_CLASSES: Record<SafetyGradeBadgeSize, string> = {
  xs: "px-2 py-0.5 text-xs font-medium",
  sm: "px-2 py-0.5 text-xs font-semibold",
  md: "px-2 py-0.5 font-mono tabular-nums text-base font-bold",
  lg: "px-3 py-1 font-mono tabular-nums text-xl font-bold",
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
  /**
   * When set, wraps the badge in `<ScoreBadgeWrapper>` so it carries the
   * methodology-aware tooltip and (per `versionVariant`) the inline `vX.Y`
   * version suffix.
   */
  versionTopic?: MethodologyContextKey;
  /** `"suffix"` (default) shows the version chip; `"tooltip-only"` hides it. */
  versionVariant?: ScoreBadgeWrapperVariant;
  /** Disable the methodology trigger when rendering inside an existing link/control. */
  versionInteractive?: boolean;
  /**
   * Appends a small "(method)" deep-link badge next to the grade pill that
   * jumps to the Safety Score methodology section. Opt-in so dense tables
   * don't get littered with it.
   * - `"always"`: visible at low contrast (hero / score cards)
   * - `"hover"`: visible only when the parent `.group` is hovered/focused
   */
  methodologyBadge?: "always" | "hover";
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
  tabIndex,
  "aria-label": ariaLabel,
  versionTopic,
  versionVariant,
  versionInteractive,
  methodologyBadge,
  ...props
}: SafetyGradeBadgeProps) {
  const scoreLabel = showScore && score !== null ? `, score ${score}` : "";
  const mergedStyle = animationDelayMs == null
    ? style
    : { ...style, animationDelay: `${animationDelayMs}ms` };

  const badge = (
    <Badge
      variant="outline"
      className={cn(
        SIZE_CLASSES[size],
        animate && "pharos-grade-pop",
        versionTopic && "pharos-focus-ring",
        getSafetyGradeBadgeClassName(grade),
        className,
      )}
      style={mergedStyle}
      tabIndex={tabIndex}
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

  const wrapped = versionTopic ? (
    <ScoreBadgeWrapper topic={versionTopic} variant={versionVariant} interactive={versionInteractive}>
      {badge}
    </ScoreBadgeWrapper>
  ) : (
    badge
  );

  if (methodologyBadge) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {wrapped}
        <MethodologyLinkBadge metric="safety-score" reveal={methodologyBadge} />
      </span>
    );
  }
  return wrapped;
}
