import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StatusMetricCard({
  label,
  value,
  subtext,
  variant = "default",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  subtext?: ReactNode;
  variant?: "default" | "tile";
  className?: string;
}) {
  if (variant === "tile") {
    return (
      <div className={cn("rounded-xl border border-border/60 bg-background/45 p-3", className)}>
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
        <div className="mt-1 font-mono text-xl font-semibold text-foreground">{value}</div>
        {subtext ? <div className="text-xs text-muted-foreground">{subtext}</div> : null}
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border border-border/50 p-3", className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-xl font-bold">{value}</div>
      {subtext ? <div className="text-xs text-muted-foreground">{subtext}</div> : null}
    </div>
  );
}
