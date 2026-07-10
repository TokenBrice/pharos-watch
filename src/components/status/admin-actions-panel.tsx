"use client";

import { useMemo, useState } from "react";
import { formatElapsedSeconds } from "@shared/lib/format";
import { getStatusPageActions, type StatusPageAction, type StatusPageActionRisk } from "@shared/lib/api-endpoints";
import type { StatusResponse } from "@shared/types";
import { History, RefreshCw, Search, X } from "lucide-react";
import { AdminActionButton } from "@/components/status/admin-action-button";
import { useAdminActionExecutions } from "@/components/status/admin-action-execution-provider";
import { SeverityPill, StatusPill } from "@/components/status/severity-pill";
import { Button } from "@/components/ui/button";
import { useAdminActionLog } from "@/hooks/use-admin-action-log";
import {
  ACTION_INTENT_COPY,
  ACTION_INTENT_ORDER,
  buildActionReadiness,
  filterActionCatalog,
  getActionIntentCategory,
  getLastActionActivity,
  reconcileActionActivity,
  type ActionActivity,
  type ActionIntentCategory,
} from "@/lib/actions-workbench-model";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";
import {
  deriveStatusActionRecommendations,
  type StatusActionRecommendation,
} from "@/lib/status/action-recommendations";

const ADMIN_ACTIONS = getStatusPageActions();

const RISK_LABEL: Record<StatusPageActionRisk, string> = {
  "read-only": "Read only",
  low: "Low",
  moderate: "Moderate",
  high: "High",
};

const RISK_CLASS: Record<StatusPageActionRisk, string> = {
  "read-only": "bg-green-500/10 text-green-700 dark:text-green-300",
  low: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  moderate: "bg-amber-500/10 text-amber-800 dark:text-amber-200",
  high: "bg-red-500/10 text-red-700 dark:text-red-300",
};

const ACTIVITY_CLASS: Record<ActionActivity["status"], string> = {
  ready: "bg-muted text-muted-foreground",
  running: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  accepted: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  queued: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  succeeded: "bg-green-500/10 text-green-700 dark:text-green-300",
  failed: "bg-red-500/10 text-red-700 dark:text-red-300",
  error: "bg-red-500/10 text-red-700 dark:text-red-300",
  unknown: "bg-amber-500/10 text-amber-800 dark:text-amber-200",
};

interface AdminActionsPanelProps {
  status: Pick<StatusResponse, "causes" | "crons">;
  nowSeconds: number;
  readinessChecks: readonly ActionReadinessCheck[];
  systemHealthy: boolean;
  recommendations?: StatusActionRecommendation[];
  onActionFinished?: () => void;
  showRecommendations?: boolean;
}

function actionScopeLabel(action: StatusPageAction): string {
  if (action.scope.type !== "asset-or-batch") return action.scope.label;
  return `${action.scope.assetLabel} or ${action.scope.batchLabel}`;
}

function dryRunLabel(action: StatusPageAction): string {
  if (!action.dryRun.supported) return "Unavailable";
  return action.dryRun.liveSupported ? "Preview and live" : "Preview only";
}

function elapsedLabel(at: number, nowSeconds: number): string {
  return `${formatElapsedSeconds(Math.max(0, nowSeconds - Math.floor(at / 1_000)))} ago`;
}

function readinessLabel(action: StatusPageAction, checks: readonly ActionReadinessCheck[]): string {
  const liveReadiness = buildActionReadiness(action, checks, "live");
  if (liveReadiness.blocked && action.dryRun.supported) return "Preview ready · live blocked";
  if (liveReadiness.blocked) return "Blocked";
  return "Ready";
}

function ActionCommands({
  action,
  readinessChecks,
  onFinished,
}: {
  action: StatusPageAction;
  readinessChecks: readonly ActionReadinessCheck[];
  onFinished: () => void;
}) {
  const configureLabel =
    action.kind === "inspect" || action.risk === "read-only"
      ? "Inspect"
      : action.dryRun.supported && !action.dryRun.liveSupported
        ? "Preview"
        : "Configure";

  return (
    <div className="flex flex-wrap gap-2 sm:justify-end">
      {action.dryRun.supported && action.dryRun.liveSupported && (
        <AdminActionButton
          action={action}
          buttonLabel="Dry run"
          fullWidth={false}
          initialDryRun
          readinessChecks={readinessChecks}
          onFinished={onFinished}
        />
      )}
      <AdminActionButton
        action={action}
        buttonLabel={configureLabel}
        fullWidth={false}
        readinessChecks={readinessChecks}
        onFinished={onFinished}
      />
    </div>
  );
}

function ActionCatalogRow({
  action,
  activities,
  nowSeconds,
  readinessChecks,
  onFinished,
}: {
  action: StatusPageAction;
  activities: readonly ActionActivity[];
  nowSeconds: number;
  readinessChecks: readonly ActionReadinessCheck[];
  onFinished: () => void;
}) {
  const liveReadiness = buildActionReadiness(action, readinessChecks, "live");
  const lastActivity = getLastActionActivity(action, activities);
  const lastPersisted = activities.find(
    (activity) => activity.actionPath === action.path && activity.source === "persisted",
  );

  return (
    <article className="border-t border-border/60 py-4 first:border-t-0">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">{action.label}</h4>
            <StatusPill className={RISK_CLASS[action.risk]}>{RISK_LABEL[action.risk]}</StatusPill>
            <StatusPill
              className={
                liveReadiness.blocked
                  ? "bg-red-500/10 text-red-700 dark:text-red-300"
                  : "bg-green-500/10 text-green-700 dark:text-green-300"
              }
            >
              {readinessLabel(action, readinessChecks)}
            </StatusPill>
          </div>
          <p className="break-all font-mono text-[11px] text-muted-foreground">{action.path}</p>
        </div>
        <ActionCommands action={action} readinessChecks={readinessChecks} onFinished={onFinished} />
      </div>

      <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2 xl:grid-cols-5">
        <div>
          <dt className="text-muted-foreground">Exact scope</dt>
          <dd className="mt-0.5 font-medium text-foreground">{actionScopeLabel(action)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expected duration</dt>
          <dd className="mt-0.5 font-medium text-foreground">{action.expectedDuration}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Dry run</dt>
          <dd className="mt-0.5 font-medium text-foreground">{dryRunLabel(action)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last persisted execution</dt>
          <dd className="mt-0.5 font-medium text-foreground">
            {lastPersisted
              ? `${elapsedLabel(lastPersisted.at, nowSeconds)} · ${lastPersisted.status}`
              : "No audited record"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Latest known outcome</dt>
          <dd className="mt-0.5 font-medium text-foreground">
            {lastActivity ? `${lastActivity.status} · ${lastActivity.source}` : "Not run in loaded history"}
          </dd>
        </div>
      </dl>

      {(action.preconditions.length > 0 || action.blockedBy.length > 0 || liveReadiness.reasons.length > 0) && (
        <details className="mt-3 text-xs">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md font-medium text-muted-foreground">
            Prerequisites {action.preconditions.length} · declared blockers {action.blockedBy.length}
            {liveReadiness.reasons.length > 0 ? ` · active blockers ${liveReadiness.reasons.length}` : ""}
          </summary>
          <div className="mt-2 grid gap-3 border-t border-border/40 pt-2 lg:grid-cols-3">
            <div>
              <div className="font-medium text-foreground">Prerequisites</div>
              {action.preconditions.length > 0 ? (
                <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                  {action.preconditions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground">No additional prerequisites declared.</p>
              )}
            </div>
            <div>
              <div className="font-medium text-foreground">Declared blockers</div>
              {action.blockedBy.length > 0 ? (
                <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                  {action.blockedBy.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground">No endpoint-specific blockers declared.</p>
              )}
            </div>
            <div>
              <div className="font-medium text-foreground">Current evidence</div>
              {liveReadiness.reasons.length > 0 ? (
                <ul className="mt-1 list-disc space-y-1 pl-4 text-red-700 dark:text-red-300">
                  {liveReadiness.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground">No active readiness blocker for live execution.</p>
              )}
              {!liveReadiness.overrideAvailable && liveReadiness.reasons.length > 0 && (
                <p className="mt-2 font-medium text-foreground">No audited override is available.</p>
              )}
            </div>
          </div>
        </details>
      )}
    </article>
  );
}

function RecentActivity({ activity, nowSeconds }: { activity: ActionActivity; nowSeconds: number }) {
  return (
    <li className="flex flex-col gap-2 border-t border-border/60 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{activity.actionLabel}</span>
          <StatusPill className={ACTIVITY_CLASS[activity.status]}>{activity.status}</StatusPill>
          <span className="text-[11px] text-muted-foreground">{activity.source}</span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {activity.target ?? "No target recorded"}
          {activity.actor ? ` · ${activity.actor}` : ""}
        </p>
      </div>
      <div className="shrink-0 text-xs text-muted-foreground">
        <span className="pharos-numeric">{elapsedLabel(activity.at, nowSeconds)}</span>
        {activity.httpStatus != null ? ` · HTTP ${activity.httpStatus}` : ""}
      </div>
    </li>
  );
}

export function AdminActionsPanel({
  status,
  nowSeconds,
  readinessChecks,
  systemHealthy,
  recommendations: suppliedRecommendations,
  onActionFinished,
  showRecommendations = true,
}: AdminActionsPanelProps) {
  const [query, setQuery] = useState("");
  const [intent, setIntent] = useState<ActionIntentCategory | "all">("all");
  const [risk, setRisk] = useState<StatusPageActionRisk | "all">("all");
  const [catalogOpen, setCatalogOpen] = useState(!systemHealthy);
  const executions = useAdminActionExecutions();
  const actionLog = useAdminActionLog();
  const recommendations = useMemo(
    () => suppliedRecommendations ?? deriveStatusActionRecommendations(status),
    [status, suppliedRecommendations],
  );
  const activities = useMemo(
    () => reconcileActionActivity(ADMIN_ACTIONS, executions, actionLog.data?.entries ?? []),
    [actionLog.data?.entries, executions],
  );
  const filteredActions = useMemo(
    () => filterActionCatalog(ADMIN_ACTIONS, { query, intent, risk }),
    [intent, query, risk],
  );
  const groupedActions = useMemo(
    () =>
      ACTION_INTENT_ORDER.map((category) => ({
        category,
        actions: filteredActions.filter((action) => getActionIntentCategory(action) === category),
      })).filter((group) => group.actions.length > 0),
    [filteredActions],
  );
  const hasFilters = query.trim().length > 0 || intent !== "all" || risk !== "all";
  const catalogVisible = catalogOpen || hasFilters;

  const handleFinished = () => {
    onActionFinished?.();
    void actionLog.refetch();
  };

  const clearFilters = () => {
    setQuery("");
    setIntent("all");
    setRisk("all");
  };

  return (
    <div className="space-y-6">
      {showRecommendations && (
        <section aria-labelledby="recommended-actions-title" className="border-y border-border/60 py-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 id="recommended-actions-title" className="text-sm font-semibold text-foreground">
                Recommended now
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Derived from active blockers and unhealthy cron lanes; readiness is checked again before execution.
              </p>
            </div>
            <span className="pharos-numeric text-xs text-muted-foreground">{recommendations.length} suggested</span>
          </div>
          {recommendations.length > 0 ? (
            <div className="mt-3 divide-y divide-border/60">
              {recommendations.map((recommendation) => (
                <div
                  key={recommendation.action.path}
                  className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{recommendation.action.label}</span>
                      <SeverityPill severity={recommendation.severity} />
                      <StatusPill
                        className={
                          buildActionReadiness(recommendation.action, readinessChecks, "live").blocked
                            ? "bg-red-500/10 text-red-700 dark:text-red-300"
                            : "bg-green-500/10 text-green-700 dark:text-green-300"
                        }
                      >
                        {readinessLabel(recommendation.action, readinessChecks)}
                      </StatusPill>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{recommendation.reason}</p>
                  </div>
                  <ActionCommands
                    action={recommendation.action}
                    readinessChecks={readinessChecks}
                    onFinished={handleFinished}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              No manual action is recommended by the current status model.
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="recent-actions-title">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <History className="size-4 text-muted-foreground" aria-hidden="true" />
              <h3 id="recent-actions-title" className="text-sm font-semibold text-foreground">
                Recent execution history
              </h3>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Every catalog action that reaches the API is audited server-side, including failures and unknown
              outcomes. Executions that never reached the API stay session-only and may not appear after reload.
            </p>
          </div>
          {actionLog.isLoading || actionLog.isFetching ? (
            <span className="text-xs text-muted-foreground" role="status">
              Loading persisted history...
            </span>
          ) : actionLog.isError ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11"
              onClick={() => void actionLog.refetch()}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Retry history
            </Button>
          ) : (
            <span className="pharos-numeric text-xs text-muted-foreground">
              {actionLog.data?.entries.length ?? 0} audited records loaded
            </span>
          )}
        </div>
        {actionLog.isError && (
          <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
            Persisted history could not be loaded: {actionLog.error?.message ?? "Unknown error"}
          </p>
        )}
        {activities.length > 0 ? (
          <ul className="mt-3">
            {activities.slice(0, 8).map((activity) => (
              <RecentActivity key={activity.id} activity={activity} nowSeconds={nowSeconds} />
            ))}
          </ul>
        ) : (
          !actionLog.isLoading && (
            <p className="mt-3 text-sm text-muted-foreground">No session or persisted execution is loaded.</p>
          )
        )}
      </section>

      <details
        open={catalogVisible}
        onToggle={(event) => {
          if (!hasFilters) setCatalogOpen(event.currentTarget.open);
        }}
        className="border-t border-border/60 pt-4"
      >
        <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center rounded-md text-sm font-semibold text-foreground marker:hidden">
          <span className="flex w-full min-w-0 items-center justify-between gap-3">
            <span>Complete action catalog</span>
            <span className="pharos-numeric text-xs font-normal text-muted-foreground" aria-live="polite">
              {filteredActions.length}/{ADMIN_ACTIONS.length} actions
            </span>
          </span>
        </summary>
        {catalogVisible ? (
          <div className="mt-4">
            <div className="flex flex-col gap-2 border-y border-border/60 bg-muted/25 p-3 lg:flex-row lg:items-center">
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <label htmlFor="admin-action-search" className="sr-only">
                  Search action catalog
                </label>
                <input
                  id="admin-action-search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search action, scope, path, or prerequisite"
                  className="h-11 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <label className="sr-only" htmlFor="admin-action-intent-filter">
                Filter by intent
              </label>
              <select
                id="admin-action-intent-filter"
                value={intent}
                onChange={(event) => setIntent(event.target.value as ActionIntentCategory | "all")}
                className="h-11 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">All intents</option>
                {ACTION_INTENT_ORDER.map((category) => (
                  <option key={category} value={category}>
                    {ACTION_INTENT_COPY[category].label}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="admin-action-risk-filter">
                Filter by risk
              </label>
              <select
                id="admin-action-risk-filter"
                value={risk}
                onChange={(event) => setRisk(event.target.value as StatusPageActionRisk | "all")}
                className="h-11 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">All risks</option>
                {Object.entries(RISK_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {hasFilters && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11"
                  onClick={clearFilters}
                  aria-label="Clear action filters"
                >
                  <X className="size-4" aria-hidden="true" />
                  Clear
                </Button>
              )}
            </div>

            {groupedActions.length > 0 ? (
              <div className="divide-y divide-border">
                {groupedActions.map((group) => (
                  <section key={group.category} aria-labelledby={`action-group-${group.category}`} className="py-5">
                    <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <h3 id={`action-group-${group.category}`} className="text-sm font-semibold text-foreground">
                          {ACTION_INTENT_COPY[group.category].label}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {ACTION_INTENT_COPY[group.category].description}
                        </p>
                      </div>
                      <span className="pharos-numeric text-xs text-muted-foreground">
                        {group.actions.length} actions
                      </span>
                    </div>
                    <div>
                      {group.actions.map((action) => (
                        <ActionCatalogRow
                          key={action.path}
                          action={action}
                          activities={activities}
                          nowSeconds={nowSeconds}
                          readinessChecks={readinessChecks}
                          onFinished={handleFinished}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="py-10 text-center">
                <p className="text-sm font-medium text-foreground">No actions match these filters.</p>
                <Button type="button" variant="ghost" size="sm" className="mt-2 min-h-11" onClick={clearFilters}>
                  Clear filters
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </details>
    </div>
  );
}
