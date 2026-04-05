import type { ReactNode } from "react";

export function StatusMetricCard({
  label,
  value,
  subtext,
}: {
  label: ReactNode;
  value: ReactNode;
  subtext?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-xl font-bold">{value}</div>
      {subtext ? <div className="text-xs text-muted-foreground">{subtext}</div> : null}
    </div>
  );
}
