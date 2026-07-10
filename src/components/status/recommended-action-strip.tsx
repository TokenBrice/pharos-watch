import type { StatusActionRecommendation } from "@/lib/status/action-recommendations";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";
import { AdminActionButton } from "@/components/status/admin-action-button";
import { SeverityPill } from "@/components/status/severity-pill";

const RECOMMENDED_ACTION_STRIP_CLASS = "rounded-xl border border-border/60 bg-background/35 p-4";

export function RecommendedActionStrip({
  recommendations,
  readinessChecks,
  onActionFinished,
}: {
  recommendations: StatusActionRecommendation[];
  readinessChecks: readonly ActionReadinessCheck[];
  onActionFinished: () => void;
}) {
  if (recommendations.length === 0) {
    return (
      <div className={RECOMMENDED_ACTION_STRIP_CLASS}>
        <div className="space-y-2">
          <p className="pharos-kicker">Recommended Now</p>
          <h3 className="text-lg font-semibold tracking-tight text-foreground">No manual intervention.</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The system is holding. Use the lane order below to sweep for softer pressure, not to chase an active breach.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={RECOMMENDED_ACTION_STRIP_CLASS}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Recommended Now</p>
          <h3 className="text-lg font-semibold tracking-tight text-foreground">Take the shortest path in.</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            These actions are derived from the current blockers and unhealthy cron lanes.
          </p>
        </div>
      </div>
      <div className="mt-3 divide-y divide-border/60">
        {recommendations.slice(0, 3).map((recommendation) => (
          <div key={recommendation.action.path} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityPill severity={recommendation.severity} />
                  <span className="text-xs text-muted-foreground">
                    {recommendation.source === "cause" ? "cause" : "cron lane"}
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
