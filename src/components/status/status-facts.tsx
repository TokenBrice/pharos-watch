"use client";

import type { StatusCause, StatusResponse } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRecommendedActionsForCause } from "./action-recommendations";
import { AdminActionButton } from "./admin-action-button";

interface StatusFactsProps {
  adminKey: string;
  dbHealthy: boolean;
  summary: StatusResponse["summary"];
  causes: StatusResponse["causes"];
  onActionFinished?: () => void;
}

function formatCauseMetric(cause: StatusCause): string | null {
  if (cause.value == null && cause.threshold == null) return null;
  const value = cause.value != null ? String(cause.value) : "—";
  const threshold = cause.threshold != null ? String(cause.threshold) : "—";
  return cause.metric ? `${cause.metric}: ${value} (threshold ${threshold})` : `value ${value} / threshold ${threshold}`;
}

function CauseList({
  title,
  causes,
  adminKey,
  onActionFinished,
}: {
  title: string;
  causes: StatusCause[];
  adminKey: string;
  onActionFinished?: () => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {causes.length === 0 ? (
        <div className="rounded-md border border-border/60 px-3 py-2 text-sm text-muted-foreground">
          No active causes in this layer.
        </div>
      ) : (
        <div className="space-y-2">
          {causes.map((cause) => {
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
                          adminKey={adminKey}
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
  adminKey,
  dbHealthy,
  summary,
  causes,
  onActionFinished,
}: StatusFactsProps) {
  const summaryCards = [
    {
      label: "DB",
      value: dbHealthy ? "healthy" : "degraded",
      tone: dbHealthy ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400",
    },
    {
      label: "Worst Cache Ratio",
      value: `${summary.worstCacheRatio.toFixed(2)}x`,
      tone: summary.worstCacheRatio > 2
        ? "text-red-600 dark:text-red-400"
        : summary.worstCacheRatio > 1.5
          ? "text-amber-600 dark:text-amber-400"
          : "text-green-600 dark:text-green-400",
    },
    {
      label: "Unhealthy Crons",
      value: String(summary.unhealthyCrons),
      tone: summary.unhealthyCrons > 0 ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400",
    },
    {
      label: "Degraded Crons",
      value: String(summary.degradedCrons),
      tone: summary.degradedCrons > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
    },
    {
      label: "Cron Errors",
      value: String(summary.cronErrors),
      tone: summary.cronErrors > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Status Facts</CardTitle>
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
        <div className="grid gap-5 xl:grid-cols-2">
          <CauseList
            title="Availability causes"
            causes={causes.availability}
            adminKey={adminKey}
            onActionFinished={onActionFinished}
          />
          <CauseList
            title="Data quality causes"
            causes={causes.dataQuality}
            adminKey={adminKey}
            onActionFinished={onActionFinished}
          />
        </div>
      </CardContent>
    </Card>
  );
}
