import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatValueStack } from "@/components/stat-tile";
import { cn } from "@/lib/utils";

interface MetricStatCardProps {
  title: ReactNode;
  /** Optional left-accent border class. When omitted, the card renders flat (homepage style). */
  borderColorClass?: string;
  /** When set, renders the left border via inline style (for non-Tailwind hex colors). */
  borderColorHex?: string;
  value?: ReactNode;
  subtext?: ReactNode;
  headerRight?: ReactNode;
  className?: string;
  contentClassName?: string;
  titleClassName?: string;
  valueClassName?: string;
  subtextClassName?: string;
  children?: ReactNode;
  onClick?: () => void;
  actionLabel?: string;
}

const TITLE_CLASS = "pharos-kicker";

export function MetricStatCard({
  title,
  borderColorClass,
  borderColorHex,
  value,
  subtext,
  headerRight,
  className,
  contentClassName,
  titleClassName,
  valueClassName,
  subtextClassName,
  children,
  onClick,
  actionLabel,
}: MetricStatCardProps) {
  const hasValue = value !== undefined && value !== null;
  const hasSubtext = subtext !== undefined && subtext !== null;
  const hasCustomContent = children !== undefined && children !== null;
  const isInteractive = typeof onClick === "function";

  return (
    <Card
      className={cn(
        "@container rounded-xl",
        (borderColorClass || borderColorHex) && "border-l-[3px]",
        borderColorClass,
        isInteractive &&
          "cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      style={borderColorHex ? { borderLeftColor: borderColorHex } : undefined}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={isInteractive ? actionLabel : undefined}
      onClick={onClick}
      onKeyDown={
        isInteractive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      <CardHeader className="pb-1">
        {headerRight ? (
          <div className="flex items-center justify-between gap-2">
            <CardTitle className={cn(TITLE_CLASS, titleClassName)}>{title}</CardTitle>
            {headerRight}
          </div>
        ) : (
          <CardTitle className={cn(TITLE_CLASS, titleClassName)}>{title}</CardTitle>
        )}
      </CardHeader>
      <CardContent className={contentClassName}>
        {hasCustomContent ? (
          children
        ) : (
          <StatValueStack
            value={hasValue ? value : undefined}
            subtext={hasSubtext ? subtext : undefined}
            valueClassName={valueClassName}
            subtextClassName={subtextClassName}
          />
        )}
      </CardContent>
    </Card>
  );
}
