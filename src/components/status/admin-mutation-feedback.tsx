"use client";

import type { AdminMutationIntentExecution } from "./admin-mutation-intent";
import { Button } from "@/components/ui/button";

export function AdminMutationFeedback({
  execution,
  onRetrySame,
  onStartNew,
  newIntentLabel,
}: {
  execution: AdminMutationIntentExecution | undefined;
  onRetrySame: () => void;
  onStartNew: () => void;
  newIntentLabel?: string;
}) {
  if (!execution || (execution.status !== "failed" && execution.status !== "unknown")) return null;
  const unknown = execution.status === "unknown";

  return (
    <div
      role={unknown ? "status" : "alert"}
      className={`space-y-2 rounded-md border px-3 py-2 text-xs ${
        unknown
          ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100"
          : "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200"
      }`}
    >
      <p className="font-medium">{unknown ? "Outcome unknown" : "Action failed"}</p>
      {unknown ? (
        <p>
          The mutation may have completed. Retry the same intent to reconcile its idempotency key before creating a new
          intent.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px]">
        <span>HTTP {execution.httpStatus ?? "no response"}</span>
        <span>attempt {execution.attempts}</span>
        <span>replay {execution.idempotentReplay == null ? "unknown" : execution.idempotentReplay ? "yes" : "no"}</span>
        <span>certainty {execution.executionCertainty ?? "unknown"}</span>
        <span className="break-all">intent {execution.idempotencyKey}</span>
      </div>
      {execution.warning ? <p>{execution.warning}</p> : null}
      {execution.output ? (
        <pre className={`max-h-40 overflow-auto rounded p-2 ${unknown ? "bg-amber-950/5" : "bg-red-950/5"}`}>
          {execution.output}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {unknown ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetrySame}>
            Retry same intent
          </Button>
        ) : null}
        <Button type="button" size="sm" variant={unknown ? "destructive" : "outline"} onClick={onStartNew}>
          {newIntentLabel ?? (unknown ? "Start new intent" : "Try new intent")}
        </Button>
      </div>
    </div>
  );
}

export function AdminMutationReceipt({
  execution,
  message,
}: {
  execution: AdminMutationIntentExecution | null;
  message: string | null;
}) {
  if (!execution || execution.status !== "succeeded" || !message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-800 dark:text-green-200"
    >
      <p>{message}</p>
      <p className="mt-1 font-mono text-[11px]">
        HTTP {execution.httpStatus ?? "unknown"} · replay {execution.idempotentReplay ? "yes" : "no"} · certainty{" "}
        {execution.executionCertainty ?? "confirmed"} · intent {execution.idempotencyKey}
      </p>
    </div>
  );
}
