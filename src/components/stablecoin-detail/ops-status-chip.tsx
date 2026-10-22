import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { OpsStatusChip } from "@/components/ops-status-chip";
import { describePartialEvidence, formatPartialEvidenceGap } from "@/lib/safety-score-reason-labels";

/**
 * The partial-evidence chip shared by the Safety Score card, hero and mobile
 * sticky bar. It names the decisive gap ("Exit not yet researched"), not a
 * generic state; the popover lists every gap and the score's assumption.
 */
export function PartialEvidenceChip({
  card,
  className,
}: {
  card: SafetyScoreV9CurrentCard;
  className?: string;
}) {
  const description = describePartialEvidence(card);
  if (description === null) return null;
  const [primary, ...rest] = description.gaps;
  return (
    <OpsStatusChip
      label={`${primary!.label}${rest.length > 0 ? ` +${rest.length}` : ""}`}
      reasonCodes={[description.reasonCode]}
      className={className}
    >
      <ul className="space-y-0.5 font-medium text-foreground">
        {description.gaps.map((gap) => <li key={gap.label}>{formatPartialEvidenceGap(gap)}</li>)}
      </ul>
      <p className="text-muted-foreground">{description.summary}</p>
    </OpsStatusChip>
  );
}
