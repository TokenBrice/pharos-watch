import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type StatTileVariant = "default" | "tile" | "yield";

const TILE_CLASS_BY_VARIANT: Record<StatTileVariant, string> = {
  default: "rounded-lg border border-border/50 p-3",
  tile: "rounded-xl border border-border/60 bg-background/45 p-3",
  yield: "rounded-xl border border-border/60 bg-muted/20 px-3 py-2 sm:p-3",
};

const LABEL_CLASS_BY_VARIANT: Record<StatTileVariant, string> = {
  default: "text-xs text-muted-foreground",
  tile: "text-[11px] uppercase tracking-[0.18em] text-muted-foreground",
  yield: "text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground",
};

const VALUE_CLASS_BY_VARIANT: Record<StatTileVariant, string> = {
  default: "font-mono text-xl font-bold",
  tile: "font-mono text-xl font-semibold text-foreground",
  yield: "font-mono text-2xl tabular-nums text-foreground",
};

const SUBTEXT_CLASS_BY_VARIANT: Record<StatTileVariant, string> = {
  default: "text-xs text-muted-foreground",
  tile: "text-xs text-muted-foreground",
  yield: "text-[11px] text-muted-foreground",
};

const VALUE_WRAP_CLASS_BY_VARIANT: Record<StatTileVariant, string> = {
  default: "",
  tile: "mt-1",
  yield: "mt-1.5",
};

const SUBTEXT_WRAP_CLASS_BY_VARIANT: Record<StatTileVariant, string> = {
  default: "",
  tile: "",
  yield: "mt-0.5",
};

export interface StatTileProps {
  label: ReactNode;
  value?: ReactNode;
  subtext?: ReactNode;
  children?: ReactNode;
  variant?: StatTileVariant;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  subtextClassName?: string;
}

export function StatTile({
  label,
  value,
  subtext,
  children,
  variant = "default",
  className,
  labelClassName,
  valueClassName,
  subtextClassName,
}: StatTileProps) {
  return (
    <div className={cn(TILE_CLASS_BY_VARIANT[variant], className)}>
      <p className={cn(LABEL_CLASS_BY_VARIANT[variant], labelClassName)}>{label}</p>
      <div className={VALUE_WRAP_CLASS_BY_VARIANT[variant]}>
        {children ?? <span className={cn(VALUE_CLASS_BY_VARIANT[variant], valueClassName)}>{value}</span>}
      </div>
      {subtext ? (
        <p className={cn(SUBTEXT_WRAP_CLASS_BY_VARIANT[variant], SUBTEXT_CLASS_BY_VARIANT[variant], subtextClassName)}>
          {subtext}
        </p>
      ) : null}
    </div>
  );
}

export function StatValueStack({
  value,
  subtext,
  valueClassName,
  subtextClassName,
}: {
  value?: ReactNode;
  subtext?: ReactNode;
  valueClassName?: string;
  subtextClassName?: string;
}) {
  return (
    <>
      {value !== undefined && value !== null ? (
        <p className={cn("font-mono text-2xl font-extrabold tabular-nums", valueClassName)}>{value}</p>
      ) : null}
      {subtext !== undefined && subtext !== null ? (
        <p className={cn("text-xs text-muted-foreground", subtextClassName)}>{subtext}</p>
      ) : null}
    </>
  );
}
