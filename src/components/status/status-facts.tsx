"use client";

import { STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { StatusCause, StatusResponse } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRecommendedActionsForCause } from "@/lib/status/action-recommendations";
import { getBlockerCauses, getWatchCauses } from "@/lib/status-dashboard-model";
import { AdminActionButton } from "./admin-action-button";

interface StatusFactsProps {
  dbHealthy: boolean;
  summary: StatusResponse["summary"];
  causes: StatusResponse["causes"];
  onActionFinished?: () => void;
}

const SEVERITY_ORDER = {
  critical: 0,
  warning: 1,
  info: 2,
} as const;

function formatCauseMetric(cause: StatusCause): string | null {
  if (cause.value == null && cause.threshold == null) return null;
  const value = cause.value != null ? String(cause.value) : "—";
  const threshold = cause.threshold != null ? String(cause.threshold) : "—";
  return cause.metric ? `${cause.metric}: ${value} (threshold ${threshold})` : `value ${value} / threshold ${threshold}`;
}

function CauseList({
  causes,
  title,
  description,
  emptyMessage,
  onActionFinished,
}: {
  causes: StatusCause[];
  title: string;
  description: string;
  emptyMessage: string;
  onActionFinished?: () => void;
}) {
  const orderedCauses = [...causes].sort((a, b) => {
    const severityDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDelta !== 0) return severityDelta;
    return a.message.localeCompare(b.message);
  });

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {orderedCauses.length === 0 ? (
        <div className="rounded-md border border-border/60 px-3 py-2 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div className="space-y-2">
          {orderedCauses.map((cause) => {
            const actions = getRecommendedActionsForCause(cause);
            const detail = formatCauseMetric(cause);
            return (
              <div key={`${cause.layer}-${cause.code}-${cause.message}`} className="rounded-lg border border-border/60 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          cause.severity === "critical"
                            ? "bg-red-500/15 text-red-700 dark:text-red-400"
                            : cause.severity === "warning"
                              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                          : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {cause.severity}
                      </span>
                      <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                        {cause.layer}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">{cause.code}</span>
                    </div>
                    <div className="text-sm">{cause.message}</div>
                    {detail && <div className="font-mono text-xs text-muted-foreground">{detail}</div>}
                  </div>
                  {actions.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {actions.map((action) => (
                        <AdminActionButton
                          key={`${cause.code}-${action.path}`}
                          action={action}
                          fullWidth={false}
                          buttonClassName="min-w-[9rem]"
                          onFinished={() => onActionFinished?.()}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function StatusFacts({
  dbHealthy,
  summary,
  causes,
  onActionFinished,
}: StatusFactsProps) {
  const summaryCards = [
    {
      label: "Worst Cache Ratio",
      value: `${summary.worstCacheRatio.toFixed(2)}x`,
      tone: summary.worstCacheRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale
        ? "text-red-600 dark:text-red-400"
        : summary.worstCacheRatio > STATUS_CACHE_RATIO_THRESHOLDS.degraded
          ? "text-amber-600 dark:text-amber-400"
          : "text-green-600 dark:text-green-400",
    },
    {
      label: "Impacting Crons",
      value: String(summary.availabilityImpactingUnhealthyCrons),
      tone: summary.availabilityImpactingUnhealthyCrons > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400",
    },
    {
      label: "Watch Crons",
      value: String(summary.watchUnhealthyCrons),
      tone: summary.watchUnhealthyCrons > 0 ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400",
    },
    {
      label: "Diag Gaps",
      value: String(summary.diagnosticIssueCount),
      tone: summary.diagnosticIssueCount > 0 ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400",
    },
    {
      label: "Cron Errors",
      value: `${summary.availabilityImpactingCronErrors}/${summary.cronErrors}`,
      tone: summary.availabilityImpactingConsecutiveCronErrors > 0
        ? "text-red-600 dark:text-red-400"
        : summary.availabilityImpactingCronErrors > 0 || summary.cronErrors > 0
          ? "text-amber-600 dark:text-amber-400"
          : "text-green-600 dark:text-green-400",
    },
    {
      label: "DB",
      value: dbHealthy ? "healthy" : "degraded",
      tone: dbHealthy ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400",
    },
  ];
  const blockerCauses = getBlockerCauses(causes);
  const watchCauses = getWatchCauses(causes);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Incident Detail</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {summaryCards.map((card) => (
            <div key={card.label} className="rounded-lg border border-border/60 p-3">
              <div className="text-xs text-muted-foreground">{card.label}</div>
              <div className={`mt-1 font-mono text-2xl font-bold ${card.tone}`}>{card.value}</div>
            </div>
          ))}
        </div>
        <CauseList
          causes={blockerCauses}
          title="Current blockers"
          description="Severity wins over subsystem. Fix the top rows first."
          emptyMessage="No active blockers."
          onActionFinished={onActionFinished}
        />
        <CauseList
          causes={watchCauses}
          title="Diagnostics watch"
          description="Visible uncertainty and advisory telemetry that do not change the global incident state by themselves."
          emptyMessage="No advisory watch items."
          onActionFinished={onActionFinished}
        />
      </CardContent>
    </Card>
  );
}
