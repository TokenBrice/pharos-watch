"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { CoinSelector } from "@/components/coin-selector";
import type {
  AdminActionDialogState,
  AdminActionExecution,
  AdminActionExecutionController,
  AdminActionExecutionRequest,
} from "@/components/status/admin-action-execution-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildActionReadiness,
  extractStructuredActionOutcome,
  getSafeActionFollowUpHref,
} from "@/lib/actions-workbench-model";
import type { CoinOption } from "@/lib/compare-types";

const STATUS_LABEL: Record<AdminActionExecution["status"], string> = {
  ready: "Ready",
  running: "Running",
  accepted: "Accepted",
  queued: "Queued",
  succeeded: "Succeeded",
  failed: "Failed",
  unknown: "Outcome unknown",
};

const KIND_LABEL = {
  inspect: "Inspection",
  backfill: "Backfill",
  repair: "Repair",
  reset: "Reset",
  communication: "Communication",
} as const;

const RISK_LABEL = {
  "read-only": "Read only",
  low: "Low risk",
  moderate: "Moderate risk",
  high: "High risk",
} as const;

const RISK_CLASS = {
  "read-only": "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
  low: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  moderate: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  high: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
} as const;

const RESULT_MODE_LABEL = {
  immediate: "Immediate result",
  queued: "Queued acknowledgement",
  continuation: "Continuation result",
} as const;

const PHAROS_REPOSITORY_BLOB_URL = "https://github.com/TokenBrice/pharos-watch/blob/main";
const EMPTY_READINESS_CHECKS = [] as const;
const NOOP_SUBSCRIBE = () => () => {};
const ADMIN_ASSET_OPTIONS: CoinOption[] = CLIENT_ACTIVE_STABLECOINS.map(({ id, name, symbol, status }) => ({
  id,
  name,
  symbol,
  frozen: status === "frozen",
}));

function getRunbookUrl(runbookPath: string): string {
  return `${PHAROS_REPOSITORY_BLOB_URL}/${runbookPath}`;
}

function setQueryParameter(path: string, name: string, value: string): string {
  const [pathname, query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  params.set(name, value);
  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

function StructuredExecutionResult({ execution }: { execution: AdminActionExecution }) {
  const outcome = extractStructuredActionOutcome(execution.resultData, execution.status);
  const followUpHref = outcome.followUp ? getSafeActionFollowUpHref(outcome.followUp) : null;
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (execution.status !== "ready" && !execution.requestInFlight) {
      resultHeadingRef.current?.focus();
    }
  }, [execution.requestInFlight, execution.status]);

  return (
    <section aria-labelledby="admin-action-outcome-title" className="space-y-3 border-t border-border/60 pt-3">
      <div>
        <h3
          ref={resultHeadingRef}
          id="admin-action-outcome-title"
          tabIndex={-1}
          className="text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {outcome.headline}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          HTTP {execution.httpStatus ?? "unknown"} · {execution.scopeLabel}
        </p>
      </div>
      {outcome.fields.length > 0 && (
        <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
          {outcome.fields.map((field) => (
            <div key={field.label}>
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="pharos-numeric mt-0.5 break-all font-medium text-foreground">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {outcome.followUp && (
        <p className="text-xs">
          <span className="text-muted-foreground">Follow-up: </span>
          {followUpHref ? (
            <a
              href={followUpHref}
              target={followUpHref.startsWith("http") ? "_blank" : undefined}
              rel={followUpHref.startsWith("http") ? "noopener noreferrer" : undefined}
              className="font-medium text-foreground underline underline-offset-4"
            >
              {outcome.followUp}
            </a>
          ) : (
            <span className="pharos-numeric font-medium text-foreground">{outcome.followUp}</span>
          )}
        </p>
      )}
      {execution.output && (
        <details>
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-xs font-medium text-muted-foreground">
            Raw JSON response
          </summary>
          <pre
            className={`mt-2 max-h-60 overflow-auto rounded-md p-3 text-xs ${
              execution.status === "failed"
                ? "bg-red-500/10 text-red-700 dark:text-red-400"
                : execution.status === "unknown"
                  ? "bg-amber-500/10 text-amber-900 dark:text-amber-100"
                  : "bg-muted"
            }`}
          >
            {execution.output}
          </pre>
        </details>
      )}
    </section>
  );
}

export function AdminActionExecutionDialog({
  request: dialogRequest,
  controller,
  onClose,
}: {
  request: AdminActionDialogState;
  controller: AdminActionExecutionController;
  onClose: () => void;
}) {
  const { action } = dialogRequest;
  const assetInputId = useId();
  const singleScopeId = useId();
  const batchScopeId = useId();
  const dryRunInputId = useId();
  const fallbackInputId = useId();
  const acknowledgementInputId = useId();
  const isSupplyBackfillAction = action.path === API_PATHS.backfillSupplyHistory();
  const assetScope = action.scope.type === "asset-or-batch" ? action.scope : null;
  const fixedScopeLabel = action.scope.type === "asset-or-batch" ? null : action.scope.label;
  const dryRunConfig = action.dryRun.supported ? action.dryRun : null;
  const initialDryRun = dryRunConfig
    ? dryRunConfig.liveSupported
      ? (dialogRequest.initialDryRun ?? dryRunConfig.default)
      : true
    : false;
  const [scopeMode, setScopeMode] = useState<"single" | "batch">("single");
  const [selectedAsset, setSelectedAsset] = useState<CoinOption | null>(null);
  const [dryRun, setDryRun] = useState(initialDryRun);
  const [allowConstantPriceFallback, setAllowConstantPriceFallback] = useState(false);
  const [broadScopeAcknowledged, setBroadScopeAcknowledged] = useState(false);
  const assetFilter = selectedAsset
    ? assetScope?.assetIdentifier === "symbol"
      ? selectedAsset.symbol
      : selectedAsset.id
    : "";
  const capturedReadinessChecks = dialogRequest.readinessChecks ?? EMPTY_READINESS_CHECKS;
  const currentReadinessChecks = useSyncExternalStore(
    dialogRequest.readinessSource?.subscribe ?? NOOP_SUBSCRIBE,
    dialogRequest.readinessSource?.getSnapshot ?? (() => capturedReadinessChecks),
    () => capturedReadinessChecks,
  );

  let requestPath = action.path;
  if (assetScope && scopeMode === "single" && assetFilter) {
    requestPath = setQueryParameter(requestPath, assetScope.queryParam, assetFilter);
  }
  if (dryRunConfig) {
    requestPath = setQueryParameter(requestPath, dryRunConfig.queryParam, dryRun ? "true" : "false");
  }
  if (isSupplyBackfillAction && allowConstantPriceFallback) {
    requestPath = setQueryParameter(requestPath, "allow-constant-price-fallback", "true");
  }

  const requestMethod = dryRunConfig
    ? dryRun
      ? (dryRunConfig.dryRunMethod ?? action.method)
      : (dryRunConfig.liveMethod ?? action.method)
    : action.method;
  const baseScopeKey = assetScope
    ? scopeMode === "single"
      ? `${assetScope.queryParam}:${assetFilter || "missing"}`
      : "batch"
    : action.scope.type;
  const executionModeKey = dryRunConfig ? (dryRun ? "dry-run" : "live") : "execute";
  const fallbackScopeKey = isSupplyBackfillAction
    ? `|constant-price-fallback:${allowConstantPriceFallback ? "allowed" : "off"}`
    : "";
  const scopeKey = `${baseScopeKey}|mode:${executionModeKey}${fallbackScopeKey}`;
  const baseScopeLabel = assetScope
    ? scopeMode === "single"
      ? selectedAsset
        ? `${selectedAsset.name} (${assetFilter})`
        : `${assetScope.assetLabel.toLowerCase()} not selected`
      : assetScope.batchLabel
    : (fixedScopeLabel ?? "Unknown scope");
  const scopeLabel = dryRunConfig && dryRun ? `${baseScopeLabel} (dry run)` : baseScopeLabel;
  const request: AdminActionExecutionRequest = { action, requestPath, requestMethod, scopeKey, scopeLabel };
  const execution = controller.current[`${action.path}\u0000${scopeKey}`];
  const loading = execution?.requestInFlight === true;
  const hasTerminalResult = Boolean(execution && execution.status !== "ready" && !execution.requestInFlight);
  const inputsLocked = Boolean(execution && execution.status !== "ready");
  const hasValidAssetScope = !assetScope || scopeMode === "batch" || selectedAsset != null;
  const isLiveMutation = !dryRun && action.risk !== "read-only";
  const requiresBroadScopeAcknowledgement = isLiveMutation && (!assetScope || scopeMode === "batch");
  const readiness = buildActionReadiness(action, currentReadinessChecks, dryRun ? "dry-run" : "live");
  const canConfirm =
    hasValidAssetScope && !readiness.blocked && (!requiresBroadScopeAcknowledgement || broadScopeAcknowledged);
  const highRiskLiveMutation = isLiveMutation && action.risk === "high";
  const confirmVariant = action.destructive || highRiskLiveMutation ? "destructive" : "default";

  const notifyWhenFinished = async (operation: Promise<{ execution: AdminActionExecution; didStart: boolean }>) => {
    const result = await operation;
    if (result.didStart) dialogRequest.onFinished?.(result.execution);
  };

  const handleConfirm = () => {
    const latestChecks = dialogRequest.readinessSource?.getSnapshot() ?? currentReadinessChecks;
    const latestReadiness = buildActionReadiness(action, latestChecks, dryRun ? "dry-run" : "live");
    if (!canConfirm || latestReadiness.blocked) return;
    void notifyWhenFinished(controller.execute(request));
  };

  const handleRetry = () => {
    if (!execution) return;
    const latestChecks = dialogRequest.readinessSource?.getSnapshot() ?? currentReadinessChecks;
    const latestReadiness = buildActionReadiness(action, latestChecks, dryRun ? "dry-run" : "live");
    if (latestReadiness.blocked) return;
    void notifyWhenFinished(controller.retry(execution.executionKey));
  };

  const handleStartNew = () => {
    setBroadScopeAcknowledged(false);
    controller.startNew(request);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !loading) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
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

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-border/60 py-3 text-xs sm:grid-cols-4">
          <div>
            <div className="text-muted-foreground">Kind</div>
            <div className="mt-0.5 font-medium text-foreground">{KIND_LABEL[action.kind]}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Risk</div>
            <span
              className={`mt-0.5 inline-flex rounded-full border px-2 py-0.5 font-medium ${RISK_CLASS[action.risk]}`}
            >
              {RISK_LABEL[action.risk]}
            </span>
          </div>
          <div>
            <div className="text-muted-foreground">Duration</div>
            <div className="mt-0.5 font-medium text-foreground">{action.expectedDuration}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Result</div>
            <div className="mt-0.5 font-medium text-foreground">{RESULT_MODE_LABEL[action.resultMode]}</div>
          </div>
        </div>

        {assetScope ? (
          <fieldset className="space-y-3" disabled={inputsLocked}>
            <legend className="text-xs font-medium text-muted-foreground">Execution scope</legend>
            <div className="grid grid-cols-2 gap-2">
              <label
                htmlFor={singleScopeId}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  scopeMode === "single" ? "border-foreground bg-muted" : "border-input bg-background"
                }`}
              >
                <input
                  id={singleScopeId}
                  type="radio"
                  name={`${assetInputId}-scope`}
                  value="single"
                  checked={scopeMode === "single"}
                  onChange={() => {
                    setScopeMode("single");
                    setBroadScopeAcknowledged(false);
                  }}
                />
                Single asset
              </label>
              <label
                htmlFor={batchScopeId}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  scopeMode === "batch" ? "border-foreground bg-muted" : "border-input bg-background"
                }`}
              >
                <input
                  id={batchScopeId}
                  type="radio"
                  name={`${assetInputId}-scope`}
                  value="batch"
                  checked={scopeMode === "batch"}
                  onChange={() => {
                    setScopeMode("batch");
                    setBroadScopeAcknowledged(false);
                  }}
                />
                Batch
              </label>
            </div>
            {scopeMode === "single" ? (
              <div className="space-y-1" role="group" aria-labelledby={assetInputId}>
                <div id={assetInputId} className="text-xs font-medium text-muted-foreground">
                  {assetScope.assetLabel}
                </div>
                <CoinSelector
                  coins={ADMIN_ASSET_OPTIONS}
                  selected={selectedAsset}
                  disabled={inputsLocked}
                  onSelect={setSelectedAsset}
                  onRemove={() => setSelectedAsset(null)}
                />
                {!selectedAsset && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    Select a tracked stablecoin for single-asset scope.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Batch scope: {assetScope.batchLabel}.</p>
            )}
          </fieldset>
        ) : (
          <div className="text-sm">
            <span className="text-muted-foreground">Execution scope: </span>
            <span className="font-medium text-foreground">{fixedScopeLabel}</span>
          </div>
        )}

        {dryRunConfig &&
          (dryRunConfig.liveSupported ? (
            <label
              htmlFor={dryRunInputId}
              className="flex min-h-11 items-start gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <input
                id={dryRunInputId}
                type="checkbox"
                checked={dryRun}
                onChange={(event) => {
                  setDryRun(event.target.checked);
                  setBroadScopeAcknowledged(false);
                }}
                disabled={inputsLocked}
              />
              <span>
                <span className="font-medium text-foreground">Dry run</span>
                <span className="block text-xs text-muted-foreground">
                  Preview the selected scope without live writes.
                </span>
              </span>
            </label>
          ) : (
            <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-800 dark:text-green-200">
              Dry run only from this dashboard control.
            </div>
          ))}

        {isSupplyBackfillAction && (
          <label
            htmlFor={fallbackInputId}
            className="flex min-h-11 items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <input
              id={fallbackInputId}
              type="checkbox"
              checked={allowConstantPriceFallback}
              onChange={(event) => {
                setAllowConstantPriceFallback(event.target.checked);
                setBroadScopeAcknowledged(false);
              }}
              disabled={inputsLocked}
            />
            Allow constant-price fallback for non-USD backfill
          </label>
        )}

        {(action.preconditions.length > 0 || action.blockedBy.length > 0 || action.rollback || action.runbookPath) && (
          <div className="space-y-3 border-t border-border/60 pt-3 text-xs">
            {action.preconditions.length > 0 && (
              <div>
                <div className="font-medium text-foreground">Prerequisites</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                  {action.preconditions.map((precondition) => (
                    <li key={precondition}>{precondition}</li>
                  ))}
                </ul>
              </div>
            )}
            {action.blockedBy.length > 0 && (
              <div>
                <div className="font-medium text-foreground">Blocked when</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                  {action.blockedBy.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </div>
            )}
            {action.rollback && (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Recovery: </span>
                {action.rollback}
              </p>
            )}
            {action.runbookPath && (
              <a
                href={getRunbookUrl(action.runbookPath)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground underline underline-offset-4"
              >
                Open operator reference<span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </div>
        )}

        {readiness.blocked && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-900 dark:text-red-100">
            <div className="font-medium">Live execution blocked</div>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
              {readiness.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs">No audited override is available for this action.</p>
          </div>
        )}

        {requiresBroadScopeAcknowledgement && (
          <label
            htmlFor={acknowledgementInputId}
            className={`flex min-h-11 items-start gap-2 rounded-md border px-3 py-2 text-sm ${
              action.risk === "high"
                ? "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-100"
                : "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100"
            }`}
          >
            <input
              id={acknowledgementInputId}
              type="checkbox"
              checked={broadScopeAcknowledged}
              onChange={(event) => setBroadScopeAcknowledged(event.target.checked)}
              disabled={inputsLocked}
            />
            I acknowledge this live action affects {baseScopeLabel}.
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
        {execution && execution.status !== "ready" && !execution.requestInFlight && (
          <StructuredExecutionResult execution={execution} />
        )}

        <DialogFooter>
          <Button className="min-h-11" variant="outline" onClick={onClose} disabled={loading}>
            {hasTerminalResult ? "Close" : "Cancel"}
          </Button>
          {hasTerminalResult && (
            <Button className="min-h-11" variant="outline" onClick={handleStartNew}>
              Start new execution
            </Button>
          )}
          {(execution?.status === "failed" || execution?.status === "unknown") && (
            <Button className="min-h-11" variant={confirmVariant} onClick={handleRetry} disabled={readiness.blocked}>
              Retry same execution
            </Button>
          )}
          {(!execution || execution.status === "ready") && (
            <Button className="min-h-11" variant={confirmVariant} onClick={handleConfirm} disabled={!canConfirm}>
              Confirm
            </Button>
          )}
          {loading && (
            <Button className="min-h-11" variant={confirmVariant} disabled aria-busy>
              Running...
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
