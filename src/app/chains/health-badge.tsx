import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { HEALTH_BADGE_CLASSES } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";
import type { HealthBand } from "@shared/types/chains";

export function HealthBadge({ score, band }: { score: number | null; band: HealthBand | null }) {
  if (score == null || band == null) {
    return <span className="text-xs text-muted-foreground">--</span>;
  }
  return (
    <ScoreBadgeWrapper topic="chainHealth" variant="tooltip-only">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
          HEALTH_BADGE_CLASSES[band],
        )}
        title={`${score} — ${band}`}
      >
        {score}
        <span className="hidden sm:inline capitalize">{band}</span>
      </span>
    </ScoreBadgeWrapper>
  );
}
