"use client";

import { useLayoutEffect, useState } from "react";
import type { StatusPageAction } from "@shared/lib/api-endpoints";
import {
  type AdminActionExecution,
  type AdminActionReadinessSource,
  useAdminActionDialog,
} from "@/components/status/admin-action-execution-provider";
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

const EMPTY_READINESS_CHECKS: readonly ActionReadinessCheck[] = [];

function createReadinessStore(initialSnapshot: readonly ActionReadinessCheck[]) {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  const source: AdminActionReadinessSource = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    source,
    update(nextSnapshot: readonly ActionReadinessCheck[]) {
      if (snapshot === nextSnapshot) return;
      snapshot = nextSnapshot;
      listeners.forEach((listener) => listener());
    },
  };
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
  const [readinessStore] = useState(() => createReadinessStore(readinessChecks ?? EMPTY_READINESS_CHECKS));

  useLayoutEffect(() => {
    readinessStore.update(readinessChecks ?? EMPTY_READINESS_CHECKS);
  }, [readinessChecks, readinessStore]);

  return (
    <Button
      type="button"
      variant={action.destructive ? "destructive" : "outline"}
      size="sm"
      className={`min-h-11 ${fullWidth ? "w-full" : ""}${buttonClassName ? ` ${buttonClassName}` : ""}`.trim()}
      disabled={loading}
      aria-busy={loading}
      data-execution-status={execution?.status ?? "idle"}
      onClick={(event) =>
        openDialog({
          action,
          initialDryRun,
          readinessChecks,
          readinessSource: readinessStore.source,
          onFinished,
          returnFocus: event.currentTarget,
        })
      }
    >
      {loading ? "Running..." : (buttonLabel ?? action.label)}
    </Button>
  );
}
