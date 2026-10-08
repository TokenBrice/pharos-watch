import type { StatusResponse } from "@shared/types";
import { formatPercentFromRatio } from "@shared/lib/format";
import { hasReserveScoreInputHold } from "@shared/lib/status-thresholds";
import { STATUS_PANEL_SHELL_CLASS, SummaryBadge } from "@/components/status/page-primitives";
import { cn } from "@/lib/utils";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { STATUS_OK_PILL_CLASS } from "@/lib/status-dashboard-model";

interface ScoreImpactPanelProps {
  reserveComposition: StatusResponse["reserveComposition"];
}


export function ScoreImpactPanel({ reserveComposition }: ScoreImpactPanelProps) {
  const reserveInputHold = hasReserveScoreInputHold(reserveComposition);
  const reserveUnavailable = reserveComposition.status === "unavailable";

  return (
    <section className={cn("rounded-xl p-4", STATUS_PANEL_SHELL_CLASS)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold tracking-tight text-foreground">Score impact monitor</h3>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Connects reserve-sync pressure to the score inputs operators see in report cards. This is not a new scoring
            rule; it shows where live reserve evidence is forcing conservative or divergent inputs.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SummaryBadge
            label="Reserve input"
            value={reserveUnavailable ? "unavailable" : reserveInputHold ? "conservative" : "clean"}
            className={
              reserveInputHold
                ? SEVERITY_TONE_CLASS.watch.pill
                : STATUS_OK_PILL_CLASS
            }
          />
          <SummaryBadge
            label="Score-grade"
            value={reserveComposition.authoritativeFreshCoverageRatio == null ? "Unknown" : formatPercentFromRatio(reserveComposition.authoritativeFreshCoverageRatio, 1)}
          />
        </div>
      </div>

      <div className="mt-4">

        <div className="space-y-3 rounded-xl border border-border/60 bg-background/45 p-3 text-xs">
          <div>
            <div className="text-sm font-medium text-foreground">Operator read</div>
            <p className="mt-1 leading-relaxed text-muted-foreground">
              {reserveUnavailable
                ? "Reserve evidence could not be read; score-input health and coverage are unknown."
                : reserveInputHold
                ? "Safety Scores may look lower where score-grade reserve evidence is missing, deferred, or downgraded."
                : "Reserve evidence is score-grade; broad score downgrades are more likely from coin-specific inputs."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-muted-foreground">Fresh</div>
              <div className="font-mono text-sm text-foreground">
                {reserveComposition.freshCoverageRatio == null ? "Unknown" : formatPercentFromRatio(reserveComposition.freshCoverageRatio, 1)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Deferred</div>
              <div className="font-mono text-sm text-foreground">{reserveComposition.deferredCoins ?? "Unknown"}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Degraded feeds</div>
              <div className="font-mono text-sm text-foreground">{reserveComposition.degradedCoins ?? "Unknown"}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
