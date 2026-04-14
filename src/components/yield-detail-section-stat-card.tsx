"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface YieldDetailSectionStatCardProps {
  label: ReactNode;
  value?: string;
  toneClass?: string;
  subtitle?: string;
  children?: ReactNode;
  className?: string;
}

export function YieldDetailSectionStatCard({
  label,
  value,
  toneClass,
  subtitle,
  children,
  className,
}: YieldDetailSectionStatCardProps) {
  return (
    <div className={cn("rounded-xl border border-border/60 bg-muted/20 px-3 py-2 sm:p-3", className)}>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <div className="mt-1.5">
        {children ?? <span className={cn("font-mono text-2xl tabular-nums text-foreground", toneClass)}>{value}</span>}
      </div>
      {subtitle ? <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p> : null}
    </div>
  );
}
