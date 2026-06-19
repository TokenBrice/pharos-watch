import type { ReactNode } from "react";
import type { StatusCause } from "@shared/types";
import { getSeverityBadgeClass } from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";

const STATUS_PILL_BASE = "rounded-full px-2 py-0.5 text-[11px] font-medium";

/** Generic status pill — accepts any color class via `className`. */
export function StatusPill({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn(STATUS_PILL_BASE, className)}>{children}</span>;
}

interface SeverityPillProps {
  severity: StatusCause["severity"];
  className?: string;
}

export function SeverityPill({ severity, className }: SeverityPillProps) {
  return (
    <StatusPill className={cn(getSeverityBadgeClass(severity), className)}>
      {severity}
    </StatusPill>
  );
}
