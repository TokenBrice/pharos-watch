import { getStatusPageActions, type StatusPageAction } from "@shared/lib/api-endpoints";
import { getCronJobMeta } from "@shared/lib/cron-jobs";
import type { CronStatus, StatusCause, StatusResponse } from "@shared/types";
import { STATUS_CAUSE_SEVERITY_RANK } from "@/lib/status/cause-severity";

const ACTION_BY_PATH = new Map<string, StatusPageAction>(
  getStatusPageActions().map((action) => [action.path, action]),
);

const CAUSE_ACTION_PATHS: Partial<Record<string, readonly string[]>> = {
  stablecoins_cache_unavailable: ["/api/backfill-cg-prices"],
  stablecoins_cache_degraded: ["/api/backfill-cg-prices"],
  missing_prices_degraded: ["/api/backfill-cg-prices"],
  missing_prices_stale: ["/api/backfill-cg-prices"],
  blacklist_gaps_degraded: [
    "/api/backfill-blacklist-current-balances",
    "/api/debug-sync-state",
    "/api/remediate-blacklist-amount-gaps",
  ],
  blacklist_gaps_stale: [
    "/api/backfill-blacklist-current-balances",
    "/api/debug-sync-state",
    "/api/remediate-blacklist-amount-gaps",
  ],
  onchain_integrity_degraded: ["/api/backfill-mint-burn", "/api/backfill-mint-burn-prices"],
  onchain_integrity_stale: ["/api/backfill-mint-burn", "/api/backfill-mint-burn-prices"],
  onchain_monitor_unavailable: ["/api/backfill-mint-burn"],
} as const;

const CRON_ACTION_PATHS: Partial<Record<string, readonly string[]>> = {
  "sync-blacklist": ["/api/reset-blacklist-sync"],
  "sync-mint-burn": ["/api/backfill-mint-burn", "/api/backfill-mint-burn-prices"],
  "sync-mint-burn-extended": ["/api/backfill-mint-burn"],
  "snapshot-supply": ["/api/backfill-supply-history"],
  "stability-index": ["/api/backfill-stability-index"],
  "snapshot-psi": ["/api/backfill-stability-index"],
  "compute-dews": ["/api/backfill-dews"],
  "daily-digest": ["/api/trigger-digest"],
} as const;

export interface StatusActionRecommendation {
  action: StatusPageAction;
  reason: string;
  severity: StatusCause["severity"];
  source: "cause" | "cron";
  sourceKey: string;
}

function getAction(path: string): StatusPageAction | null {
  return ACTION_BY_PATH.get(path) ?? null;
}

export function getRecommendedActionsForCause(cause: StatusCause): StatusPageAction[] {
  return (CAUSE_ACTION_PATHS[cause.code] ?? [])
    .map((path) => getAction(path))
    .filter((action): action is StatusPageAction => action != null);
}

function countConsecutive(runs: CronStatus["recentRuns"], status: string): number {
  let count = 0;
  for (const run of runs) {
    if (run.status !== status) break;
    count += 1;
  }
  return count;
}

function pushRecommendation(
  recommendations: Map<string, StatusActionRecommendation>,
  next: StatusActionRecommendation,
): void {
  const existing = recommendations.get(next.action.path);
  if (!existing || STATUS_CAUSE_SEVERITY_RANK[next.severity] < STATUS_CAUSE_SEVERITY_RANK[existing.severity]) {
    recommendations.set(next.action.path, next);
  }
}

export function deriveStatusActionRecommendations(
  status: Pick<StatusResponse, "causes" | "crons">,
): StatusActionRecommendation[] {
  const recommendations = new Map<string, StatusActionRecommendation>();

  for (const cause of status.causes.overall) {
    if (cause.severity === "info") continue;
    for (const action of getRecommendedActionsForCause(cause)) {
      pushRecommendation(recommendations, {
        action,
        reason: cause.message,
        severity: cause.severity,
        source: "cause",
        sourceKey: cause.code,
      });
    }
  }

  for (const [job, cron] of Object.entries(status.crons)) {
    if (cron.healthy) continue;
    if (getCronJobMeta(job)?.statusImpact !== "critical") continue;

    const actions = CRON_ACTION_PATHS[job] ?? [];
    const jobMeta = getCronJobMeta(job);
    const errorStreak = countConsecutive(cron.recentRuns, "error");
    const skippedStreak = countConsecutive(cron.recentRuns, "skipped_locked");
    const reason = errorStreak > 0
      ? `${jobMeta?.label ?? job} has ${errorStreak} consecutive error run(s).`
      : skippedStreak > 0
        ? `${jobMeta?.label ?? job} has ${skippedStreak} consecutive lease-skipped run(s).`
        : `${jobMeta?.label ?? job} is stale or missing recent runs.`;

    for (const path of actions) {
      const action = getAction(path);
      if (!action) continue;
      pushRecommendation(recommendations, {
        action,
        reason,
        severity: errorStreak > 0 ? "critical" : "warning",
        source: "cron",
        sourceKey: job,
      });
    }
  }

  return [...recommendations.values()]
    .sort((a, b) => {
      if (STATUS_CAUSE_SEVERITY_RANK[a.severity] !== STATUS_CAUSE_SEVERITY_RANK[b.severity]) {
        return STATUS_CAUSE_SEVERITY_RANK[a.severity] - STATUS_CAUSE_SEVERITY_RANK[b.severity];
      }
      return a.action.label.localeCompare(b.action.label);
    })
    .slice(0, 6);
}
