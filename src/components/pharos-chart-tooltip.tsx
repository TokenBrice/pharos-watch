import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PharosChartTooltipProps {
  active?: boolean;
  children: ReactNode;
  className?: string;
}

export function PharosChartTooltip({ active, children, className }: PharosChartTooltipProps) {
  if (!active) return null;
  return (
    <div
      className={cn(
        "rounded-xl border border-border/70 bg-card/95 px-3.5 py-3 backdrop-blur-md",
        "text-sm",
        className,
      )}
      style={{ boxShadow: "var(--elevation-raised)" }}
    >
      {children}
    </div>
  );
}

export function TooltipLabel({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-foreground/88">{children}</p>;
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
