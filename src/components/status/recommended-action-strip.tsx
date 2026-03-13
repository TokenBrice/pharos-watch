import type { StatusActionRecommendation } from "@/components/status/action-recommendations";
import { AdminActionButton } from "@/components/status/admin-action-button";
import { cn } from "@/lib/utils";

export function RecommendedActionStrip({
  recommendations,
  adminKey,
  onActionFinished,
}: {
  recommendations: StatusActionRecommendation[];
  adminKey: string;
  onActionFinished: () => void;
}) {
  if (recommendations.length === 0) {
    return (
      <div className="rounded-[1.55rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))] p-5 shadow-[0_18px_48px_oklch(0_0_0_/0.16)]">
        <div className="space-y-2">
          <p className="pharos-kicker">Recommended Now</p>
          <h3 className="text-[1.45rem] font-semibold tracking-tight text-foreground">No manual intervention.</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The system is holding. Use the lane order below to sweep for softer pressure, not to chase an active breach.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[1.55rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))] p-5 shadow-[0_18px_48px_oklch(0_0_0_/0.16)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Recommended Now</p>
          <h3 className="text-[1.45rem] font-semibold tracking-tight text-foreground">Take the shortest path in.</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            These actions are derived from the current blockers and unhealthy cron lanes.
          </p>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {recommendations.slice(0, 3).map((recommendation) => (
          <div key={recommendation.action.path} className="rounded-[1.15rem] border border-white/10 bg-black/18 p-3.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium",
                      recommendation.severity === "critical"
                        ? "bg-red-500/15 text-red-700 dark:text-red-400"
                        : recommendation.severity === "warning"
                          ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {recommendation.severity}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {recommendation.source === "cause" ? "cause" : "cron lane"}
                  </span>
                </div>
                <div className="text-sm font-medium text-foreground">{recommendation.action.label}</div>
                <div className="text-xs leading-relaxed text-muted-foreground">{recommendation.reason}</div>
              </div>
              <AdminActionButton
                action={recommendation.action}
                adminKey={adminKey}
                fullWidth={false}
                buttonClassName="min-w-[10rem]"
                onFinished={() => onActionFinished()}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
