import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { OpsStatusChip } from "@/components/ops-status-chip";
import { describePartialEvidence, formatPartialEvidenceHeadline } from "@/lib/safety-score-reason-labels";

/**
 * The partial-evidence chip shared by the Safety Score card, hero and mobile
 * sticky bar. It names the decisive gap ("Exit not yet researched"), not a
 * generic state; the popover names every gap and the score's assumption.
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
  return (
    <OpsStatusChip
      label={formatPartialEvidenceHeadline(description)}
      reasonCodes={[description.reasonCode]}
      className={className}
    >
      {description.gaps.length > 1 ? (
        <ul className="space-y-0.5 font-medium text-foreground">
          {description.gaps.map((gap) => <li key={gap.label}>{gap.label}</li>)}
        </ul>
      ) : null}
      <p className="text-foreground">{description.summary}</p>
    </OpsStatusChip>
  );
}
