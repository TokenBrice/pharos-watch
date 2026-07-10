"use client";

import { useId, useState } from "react";
import { API_PATHS, type StatusPageAction } from "@shared/lib/api-endpoints";
import {
  type AdminActionExecution,
  type AdminActionExecutionRequest,
  useAdminActionExecution,
} from "@/components/status/admin-action-execution-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface AdminActionButtonProps {
  action: StatusPageAction;
  buttonClassName?: string;
  fullWidth?: boolean;
  onFinished?: (execution: AdminActionExecution) => void;
}

const STATUS_LABEL: Record<AdminActionExecution["status"], string> = {
  ready: "Ready",
  running: "Running",
  accepted: "Accepted",
  queued: "Queued",
  succeeded: "Succeeded",
  failed: "Failed",
  unknown: "Outcome unknown",
};

function appendQuery(path: string, name: string, value: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${name}=${encodeURIComponent(value)}`;
}

export function AdminActionButton({ action, buttonClassName, fullWidth = true, onFinished }: AdminActionButtonProps) {
  const stablecoinInputId = useId();
  const fallbackInputId = useId();
  const isSupplyBackfillAction = action.path === API_PATHS.backfillSupplyHistory();
  const [open, setOpen] = useState(false);
  const [stablecoinFilter, setStablecoinFilter] = useState("");
  const [allowConstantPriceFallback, setAllowConstantPriceFallback] = useState(false);
  const trimmedFilter = stablecoinFilter.trim();
  const pathWithStablecoin =
    action.acceptsStablecoinFilter && trimmedFilter
      ? appendQuery(action.path, "stablecoin", trimmedFilter)
      : action.path;
  const requestPath =
    isSupplyBackfillAction && allowConstantPriceFallback
      ? appendQuery(pathWithStablecoin, "allow-constant-price-fallback", "true")
      : pathWithStablecoin;
  const baseScopeKey = action.acceptsStablecoinFilter ? `stablecoin:${trimmedFilter || "batch"}` : "global";
  const scopeKey = isSupplyBackfillAction
    ? `${baseScopeKey}|constant-price-fallback:${allowConstantPriceFallback ? "allowed" : "off"}`
    : baseScopeKey;
  const scopeLabel = action.acceptsStablecoinFilter
    ? trimmedFilter
      ? `stablecoin ${trimmedFilter}`
      : "batch"
    : "global";
  const request: AdminActionExecutionRequest = { action, requestPath, scopeKey, scopeLabel };
  const { execution, execute, retry, startNew } = useAdminActionExecution(action.path, scopeKey);
  const loading = execution?.requestInFlight === true;
  const hasTerminalResult = Boolean(execution && execution.status !== "ready" && !execution.requestInFlight);
  const inputsLocked = Boolean(execution && execution.status !== "ready");

  const notifyWhenFinished = async (operation: Promise<{ execution: AdminActionExecution; didStart: boolean }>) => {
    const result = await operation;
    if (result.didStart) onFinished?.(result.execution);
  };

  const handleConfirm = () => {
    void notifyWhenFinished(execute(request));
  };

  const handleRetry = () => {
    if (!execution) return;
    void notifyWhenFinished(retry(execution.executionKey));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && loading) return;
        setOpen(isOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={action.destructive ? "destructive" : "outline"}
          size="sm"
          className={`${fullWidth ? "w-full" : ""}${buttonClassName ? ` ${buttonClassName}` : ""}`.trim()}
          disabled={loading}
          aria-busy={loading}
          data-execution-status={execution?.status ?? "idle"}
        >
          {loading ? "Running..." : action.label}
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={!loading}
        onEscapeKeyDown={(event) => {
          if (loading) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (loading) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          <DialogDescription>{action.confirm}</DialogDescription>
        </DialogHeader>
        {action.acceptsStablecoinFilter && (
          <div className="space-y-1">
            <label htmlFor={stablecoinInputId} className="text-xs font-medium text-muted-foreground">
              Stablecoin ID <span className="font-normal">(optional — leave empty for batch)</span>
            </label>
            <input
              id={stablecoinInputId}
              type="text"
              value={stablecoinFilter}
              onChange={(event) => setStablecoinFilter(event.target.value)}
              placeholder="e.g. usdt-tether"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              disabled={inputsLocked}
            />
          </div>
        )}
        {isSupplyBackfillAction && (
          <label
            htmlFor={fallbackInputId}
            className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <input
              id={fallbackInputId}
              type="checkbox"
              checked={allowConstantPriceFallback}
              onChange={(event) => setAllowConstantPriceFallback(event.target.checked)}
              disabled={inputsLocked}
            />
            Allow constant-price fallback for non-USD backfill
          </label>
        )}
        {execution && execution.status !== "ready" && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs">
            <span>
              Status: <strong>{STATUS_LABEL[execution.status]}</strong>
            </span>
            <span>Scope: {execution.scopeLabel}</span>
            <span>Attempt: {execution.attempts}</span>
            {execution.idempotentReplay !== null && (
              <span>Idempotent replay: {execution.idempotentReplay ? "yes" : "no"}</span>
            )}
            {execution.executionCertainty && <span>Certainty: {execution.executionCertainty}</span>}
          </div>
        )}
        {execution?.warning && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            {execution.warning}
          </div>
        )}
        {execution?.status === "unknown" && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
            The action may have started. Retry the same execution to reconcile this idempotency key, or explicitly
            create a new execution after checking downstream state.
          </div>
        )}
        {execution?.output && (
          <pre
            className={`max-h-60 overflow-auto rounded p-3 text-xs ${
              execution.status === "failed" || execution.status === "unknown"
                ? "bg-red-500/10 text-red-700 dark:text-red-400"
                : "bg-muted"
            }`}
          >
            {execution.output}
          </pre>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            {hasTerminalResult ? "Close" : "Cancel"}
          </Button>
          {hasTerminalResult && (
            <Button variant="outline" onClick={() => startNew(request)}>
              Start new execution
            </Button>
          )}
          {(execution?.status === "failed" || execution?.status === "unknown") && (
            <Button variant={action.destructive ? "destructive" : "default"} onClick={handleRetry}>
              Retry same execution
            </Button>
          )}
          {(!execution || execution.status === "ready") && (
            <Button variant={action.destructive ? "destructive" : "default"} onClick={handleConfirm}>
              Confirm
            </Button>
          )}
          {loading && (
            <Button variant={action.destructive ? "destructive" : "default"} disabled aria-busy>
              Running...
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
