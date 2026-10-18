import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { HEALTH_BADGE_CLASSES } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";
import type { HarborFlag } from "@shared/lib/harbor-scene";

/** Renders Harbor's flag for the chain, so the table and the scene share one band and NR-reason vocabulary. */
export function HealthBadge({ flag }: { flag: HarborFlag }) {
  if (flag.kind === "unrated") {
    return (
      <span
        className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted-foreground"
        title={flag.reason}
      >
        NR
        <span className="sr-only">: {flag.reason}</span>
      </span>
    );
  }
  return (
    <ScoreBadgeWrapper topic="chainHealth" variant="tooltip-only">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
          HEALTH_BADGE_CLASSES[flag.band],
        )}
        title={flag.score == null ? flag.label : `${flag.score} — ${flag.label}`}
      >
        {flag.score}
        <span className={cn("capitalize", flag.score == null ? "" : "hidden sm:inline")}>{flag.label}</span>
      </span>
    </ScoreBadgeWrapper>
  );
}
