import type { ComponentProps, ReactNode } from "react";
import { CHART_TOOLTIP_SURFACE } from "@/lib/chart-theme";
import { cn } from "@/lib/utils";

interface PharosChartTooltipProps {
  active?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * The one chart tooltip shell: Recharts `content` tooltips render it, and
 * hand-positioned SVG readouts reuse it through `ChartTooltipSurface`.
 */
export function PharosChartTooltip({ active, children, className }: PharosChartTooltipProps) {
  if (!active) return null;
  return <ChartTooltipSurface className={className}>{children}</ChartTooltipSurface>;
}

export function ChartTooltipSurface({ className, style, ...props }: ComponentProps<"div">) {
  return <div className={cn("text-sm", className)} style={{ ...CHART_TOOLTIP_SURFACE, ...style }} {...props} />;
}

export function TooltipLabel({ children }: { children: ReactNode }) {
  return <p className="pharos-label mb-2 text-foreground/88">{children}</p>;
}

export function TooltipRow({
  color,
  label,
  value,
  bold,
}: {
  color?: string;
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {color && (
          <span
            className="inline-block size-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        {label}
      </span>
      <span className={cn("font-mono tabular-nums text-foreground", bold && "font-semibold")}>
        {value}
      </span>
    </div>
  );
}
