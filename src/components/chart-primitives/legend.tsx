import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Legend swatch + label. Recharts-free, so hand-rolled SVG charts and server sections can use it. */
export function ChartLegendChip({
  children,
  markerClassName = "inline-block h-2.5 w-2.5 rounded-full",
  markerStyle,
  className,
}: {
  children: ReactNode;
  markerClassName?: string;
  markerStyle?: CSSProperties;
  className?: string;
}) {
  return (
    <div className={cn("pharos-chart-legend-chip", className)}>
      <span aria-hidden className={markerClassName} style={markerStyle} />
      {children}
    </div>
  );
}
