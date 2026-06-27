import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";
import { cn } from "@/lib/utils";

interface ActionReadinessPanelProps {
  checks: ActionReadinessCheck[];
}

const STATE_LABEL: Record<ActionReadinessCheck["state"], string> = {
  ready: "ready",
  watch: "watch",
  blocked: "blocked",
};

const STATE_CLASS: Record<ActionReadinessCheck["state"], string> = {
  ready: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
  watch: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blocked: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
};

export function ActionReadinessPanel({ checks }: ActionReadinessPanelProps) {
  const blockedCount = checks.filter((check) => check.state === "blocked").length;
  const watchCount = checks.filter((check) => check.state === "watch").length;

  return (
    <section className="rounded-xl border border-border/60 bg-background/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold tracking-tight text-foreground">Action readiness</h3>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Preflight checks before running manual recovery. These checks are read-only and do not expose new action
            buttons.
          </p>
        </div>
        <span
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-medium",
            blockedCount > 0 ? STATE_CLASS.blocked : watchCount > 0 ? STATE_CLASS.watch : STATE_CLASS.ready,
          )}
        >
          {blockedCount > 0 ? `${blockedCount} blocked` : watchCount > 0 ? `${watchCount} watch` : "ready"}
        </span>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {checks.map((check) => (
          <div key={check.id} className="rounded-xl border border-border/60 bg-background/45 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-foreground">{check.label}</div>
              <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATE_CLASS[check.state])}>
                {STATE_LABEL[check.state]}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{check.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
