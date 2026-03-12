"use client";

import { useMemo, useState } from "react";
import { getStatusPageActions } from "@shared/lib/api-endpoints";
import type { StatusResponse } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { deriveStatusActionRecommendations } from "./action-recommendations";
import { AdminActionButton, type AdminActionExecution } from "./admin-action-button";
import { formatAge } from "./format";

const ADMIN_ACTIONS = getStatusPageActions();

interface AdminActionsPanelProps {
  adminKey: string;
  status: Pick<StatusResponse, "causes" | "crons">;
  nowSeconds: number;
  onActionFinished?: () => void;
  showRecommendations?: boolean;
}

export function AdminActionsPanel({
  adminKey,
  status,
  nowSeconds,
  onActionFinished,
  showRecommendations = true,
}: AdminActionsPanelProps) {
  const [executions, setExecutions] = useState<AdminActionExecution[]>([]);

  const recommendations = useMemo(
    () => deriveStatusActionRecommendations(status),
    [status],
  );

  const handleFinished = (execution: AdminActionExecution) => {
    setExecutions((prev) => [execution, ...prev].slice(0, 6));
    onActionFinished?.();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Admin Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {showRecommendations && recommendations.length > 0 && (
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">Recommended now</h3>
              <p className="text-xs text-muted-foreground">
                Suggestions derived from active causes and unhealthy cron lanes.
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {recommendations.map((recommendation) => (
                <div key={recommendation.action.path} className="rounded-lg border border-border/60 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <div className="text-sm font-medium">{recommendation.action.label}</div>
                      <div className="text-xs text-muted-foreground">{recommendation.reason}</div>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        recommendation.severity === "critical"
                          ? "bg-red-500/15 text-red-700 dark:text-red-400"
                          : recommendation.severity === "warning"
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {recommendation.severity}
                    </span>
                  </div>
                  <div className="mt-3">
                    <AdminActionButton
                      action={recommendation.action}
                      adminKey={adminKey}
                      onFinished={handleFinished}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">All actions</h3>
            <p className="text-xs text-muted-foreground">
              Manual tools exposed by the worker router for backfills, audits, and recovery flows.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {ADMIN_ACTIONS.map((action) => (
              <AdminActionButton
                key={action.path}
                action={action}
                adminKey={adminKey}
                onFinished={handleFinished}
              />
            ))}
          </div>
        </div>

        {executions.length > 0 && (
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">Recent results</h3>
              <p className="text-xs text-muted-foreground">
                Latest action outcomes from this browser session.
              </p>
            </div>
            <div className="space-y-2">
              {executions.map((execution) => (
                <div key={`${execution.action.path}-${execution.executedAt}`} className="rounded-md border border-border/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium">{execution.action.label}</div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        execution.ok
                          ? "bg-green-500/15 text-green-700 dark:text-green-400"
                          : "bg-red-500/15 text-red-700 dark:text-red-400"
                      }`}
                    >
                      {execution.ok ? "ok" : "error"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatAge(Math.max(0, nowSeconds - execution.executedAt))} ago
                  </div>
                  <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2 text-xs">
                    {execution.output}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
