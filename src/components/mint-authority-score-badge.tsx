import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The Mint Authority Score pill — the published V9 mint component score in its
 * band colour, with the review-bucket sentence in the tooltip.
 *
 * Sibling of `SafetyGradeBadge`: one pill + tooltip grammar shared by the
 * screener table (desktop cell and mobile card) and the homepage stablecoin
 * table, which had each hand-written it.
 */
export function MintAuthorityScoreBadge({
  scoreLabel,
  detail,
  reviewBucketLabel,
  badgeClassName,
  className,
}: {
  /** e.g. `70/100` or `NR`. */
  scoreLabel: string;
  /** Sentence describing the score, e.g. `Mint Authority Score: 70/100 (Governed).` */
  detail: string;
  /** Review-route bucket, e.g. `Governed` — appended to the tooltip. */
  reviewBucketLabel: string;
  /** Band tone from `resolveMintAuthorityScoreDisplay`. */
  badgeClassName: string;
  /** Placement utilities only. */
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("px-2 py-0.5 pharos-numeric text-xs", badgeClassName, className)}
      title={`${detail} Review bucket: ${reviewBucketLabel}.`}
    >
      {scoreLabel}
    </Badge>
  );
}
