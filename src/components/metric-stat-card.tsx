import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatValueStack } from "@/components/stat-tile";
import { cn } from "@/lib/utils";

type MetricStatCardVariant = "default" | "hero" | "compact";

const CONTENT_CLASS_BY_VARIANT: Record<MetricStatCardVariant, string> = {
  default: "",
  hero: "pt-1",
  compact: "",
};

const VALUE_CLASS_BY_VARIANT: Record<MetricStatCardVariant, string> = {
  default: "",
  hero: "pharos-numeric text-4xl font-semibold leading-none sm:text-5xl",
  compact: "pharos-numeric text-2xl font-extrabold tracking-tight",
};

const SUBTEXT_CLASS_BY_VARIANT: Record<MetricStatCardVariant, string> = {
  default: "",
  hero: "mt-2 text-sm text-muted-foreground",
  compact: "text-sm text-muted-foreground",
};

interface MetricStatCardProps {
  title: ReactNode;
  value?: ReactNode;
  subtext?: ReactNode;
  headerRight?: ReactNode;
  className?: string;
  valueClassName?: string;
  subtextClassName?: string;
  children?: ReactNode;
  variant?: MetricStatCardVariant;
}

function MetricStatCardContent({
  title,
  value,
  subtext,
  headerRight,
  valueClassName,
  subtextClassName,
  children,
  variant,
}: Omit<MetricStatCardProps, "className"> & { variant: MetricStatCardVariant }) {
  return (
    <>
      <CardHeader className="pb-1">
        {headerRight ? (
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="pharos-kicker">{title}</CardTitle>
            {headerRight}
          </div>
        ) : (
          <CardTitle className="pharos-kicker">{title}</CardTitle>
        )}
      </CardHeader>
      <CardContent className={CONTENT_CLASS_BY_VARIANT[variant]}>
        {children !== undefined && children !== null ? children : (
          <StatValueStack
            value={value}
            subtext={subtext}
            valueClassName={cn(VALUE_CLASS_BY_VARIANT[variant], valueClassName)}
            subtextClassName={cn(SUBTEXT_CLASS_BY_VARIANT[variant], subtextClassName)}
          />
        )}
      </CardContent>
    </>
  );
}

export function MetricStatCard({ variant = "default", className, ...props }: MetricStatCardProps) {
  return (
    <Card className={cn("@container pharos-card-shell", className)}>
      <MetricStatCardContent {...props} variant={variant} />
    </Card>
  );
}

export function InteractiveMetricStatCard({
  actionLabel,
  onClick,
  variant = "hero",
  className,
  ...props
}: MetricStatCardProps & { actionLabel: string; onClick: () => void }) {
  return (
    <Card className={cn("@container pharos-card-shell relative transition-colors hover:bg-muted/40", className)}>
      <MetricStatCardContent {...props} variant={variant} />
      <button
        type="button"
        className="absolute inset-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={actionLabel}
        onClick={onClick}
      />
    </Card>
  );
}
