import type { StatusCause } from "@shared/types";
import { getSeverityBadgeClass } from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";

interface SeverityPillProps {
  severity: StatusCause["severity"];
  className?: string;
}

export function SeverityPill({ severity, className }: SeverityPillProps) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        getSeverityBadgeClass(severity),
        className,
      )}
    >
      {severity}
    </span>
  );
}
