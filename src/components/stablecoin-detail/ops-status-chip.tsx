import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { OpsStatusChip } from "@/components/ops-status-chip";
import { describePartialEvidence } from "@/lib/safety-score-reason-labels";

/** The "Partial evidence" chip shared by the Safety Score card, hero and mobile sticky bar. */
export function PartialEvidenceChip({
  partialEvidence,
  className,
}: {
  partialEvidence: NonNullable<SafetyScoreV9CurrentCard["partialEvidence"]>;
  className?: string;
}) {
  const description = describePartialEvidence(partialEvidence);
  return (
    <OpsStatusChip label="Partial evidence" reasonCodes={[description.reasonCode]} className={className}>
      <p className="text-foreground">{description.summary}</p>
    </OpsStatusChip>
  );
}
