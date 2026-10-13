import type { StatusActionRecommendation } from "@/lib/status/action-recommendations";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";
import { AdminActionButton } from "@/components/status/admin-action-button";
import { STATUS_PANEL_SHELL_CLASS, VerdictPill } from "@/components/status/page-primitives";

const RECOMMENDED_ACTION_STRIP_CLASS = `rounded-xl p-4 ${STATUS_PANEL_SHELL_CLASS}`;

export function RecommendedActionStrip({
  recommendations,
  readinessChecks,
  onActionFinished,
}: {
  recommendations: StatusActionRecommendation[];
  readinessChecks: readonly ActionReadinessCheck[];
  onActionFinished: () => void;
}) {
  // Same source as the Actions workspace (`deriveStatusActionRecommendations`):
  // nothing recommended renders nothing, never a generic "investigate" card.
  if (recommendations.length === 0) return null;

  return (
    <div className={RECOMMENDED_ACTION_STRIP_CLASS}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-label">Recommended now</p>
          <h3 className="text-sm font-semibold text-foreground">
            {recommendations.length === 1 ? "1 recommended action" : `${recommendations.length} recommended actions`}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Derived from active causes and unhealthy cron lanes, the same list as the Actions workspace.
            {recommendations.length > 3 ? ` Showing 3 of ${recommendations.length}.` : ""}
          </p>
        </div>
      </div>
      <div className="mt-3 divide-y divide-border/60">
        {recommendations.slice(0, 3).map((recommendation) => (
          <div key={recommendation.action.path} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <VerdictPill verdict={recommendation.severity === "critical" ? "act" : "watch"} />
                  <span className="text-xs text-muted-foreground">
                    {recommendation.source === "cause" ? "From a status cause" : "From a cron lane"}
                  </span>
                </div>
                <div className="text-sm font-medium text-foreground">{recommendation.action.label}</div>
                <div className="text-xs leading-relaxed text-muted-foreground">{recommendation.reason}</div>
              </div>
              <AdminActionButton
                action={recommendation.action}
                fullWidth={false}
                buttonClassName="min-w-[10rem]"
                readinessChecks={readinessChecks}
                onFinished={() => onActionFinished()}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
