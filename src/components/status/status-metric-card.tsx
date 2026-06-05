import type { ReactNode } from "react";
import { StatTile } from "@/components/stat-tile";

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
  return (
    <StatTile
      label={label}
      value={value}
      subtext={subtext}
      variant={variant}
      className={className}
    />
  );
}
