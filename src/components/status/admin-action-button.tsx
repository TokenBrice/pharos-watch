"use client";

import type { StatusPageAction } from "@shared/lib/api-endpoints";
import { type AdminActionExecution, useAdminActionDialog } from "@/components/status/admin-action-execution-provider";
import { Button } from "@/components/ui/button";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";

interface AdminActionButtonProps {
  action: StatusPageAction;
  buttonClassName?: string;
  buttonLabel?: string;
  fullWidth?: boolean;
  initialDryRun?: boolean;
  readinessChecks?: readonly ActionReadinessCheck[];
  onFinished?: (execution: AdminActionExecution) => void;
}

export function AdminActionButton({
  action,
  buttonClassName,
  buttonLabel,
  fullWidth = true,
  initialDryRun,
  readinessChecks,
  onFinished,
}: AdminActionButtonProps) {
  const { execution, openDialog } = useAdminActionDialog(action.path);
  const loading = execution?.requestInFlight === true;

  return (
    <Button
      type="button"
      variant={action.destructive ? "destructive" : "outline"}
      size="sm"
      className={`${fullWidth ? "w-full" : ""}${buttonClassName ? ` ${buttonClassName}` : ""}`.trim()}
      disabled={loading}
      aria-busy={loading}
      data-execution-status={execution?.status ?? "idle"}
      onClick={() => openDialog({ action, initialDryRun, readinessChecks, onFinished })}
    >
      {loading ? "Running..." : (buttonLabel ?? action.label)}
    </Button>
  );
}
