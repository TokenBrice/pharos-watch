import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface MetricStatCardProps {
  title: ReactNode;
  borderColorClass: string;
  value?: ReactNode;
  subtext?: ReactNode;
  headerRight?: ReactNode;
  className?: string;
  contentClassName?: string;
  titleClassName?: string;
  valueClassName?: string;
  subtextClassName?: string;
  children?: ReactNode;
}

const TITLE_CLASS = "text-xs font-semibold uppercase tracking-wider text-muted-foreground";
const VALUE_CLASS = "text-2xl font-extrabold font-mono tabular-nums";
const SUBTEXT_CLASS = "text-xs text-muted-foreground";

export function MetricStatCard({
  title,
  borderColorClass,
  value,
  subtext,
  headerRight,
  className,
  contentClassName,
  titleClassName,
  valueClassName,
  subtextClassName,
  children,
}: MetricStatCardProps) {
  const hasValue = value !== undefined && value !== null;
  const hasSubtext = subtext !== undefined && subtext !== null;
  const hasCustomContent = children !== undefined && children !== null;

  return (
    <Card className={cn("rounded-xl border-l-[3px]", borderColorClass, className)}>
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
          <>
            {hasValue && <p className={cn(VALUE_CLASS, valueClassName)}>{value}</p>}
            {hasSubtext && <p className={cn(SUBTEXT_CLASS, subtextClassName)}>{subtext}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
