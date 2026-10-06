"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { CollapsibleProse } from "@/components/stablecoin-detail/collapsible-prose";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import {
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import type { MechanismReviewView } from "@/lib/mechanism-review";

/**
 * The reviewed evidence behind the Backing pillar's mechanism component scores.
 * Those scores render in the report card; this is the "why we believe this" —
 * dated analyst prose and the sources it was measured against.
 *
 * Body-only: the page mounts it once, inside the `#backing-evidence` group's
 * `RailCopyFold` band, which owns the shell, the "Mechanism review" title and
 * the `#mechanism-review` anchor. The archetype badge and reviewed date sit in
 * the first body row.
 */
export function MechanismReviewPanel({ review }: { review: MechanismReviewView | null }) {
  if (review === null) return null;

  const archetypeLabel = getMechanismArchetypeLabel(review.archetype);
  const archetypeBadge = (
    <Badge
      variant="outline"
      className="border-border/60 bg-muted/30 text-[11px] font-medium text-muted-foreground"
    >
      {archetypeLabel}
    </Badge>
  );
  const explainerLink = (
    <Link
      href={getMechanismExplainerPath(review.archetype)}
      className="pharos-focus-ring rounded-sm text-xs text-frost-blue underline-offset-2 hover:underline"
    >
      How {archetypeLabel.toLowerCase()} stablecoins work
    </Link>
  );
  // The dated analyst prose runs to ~1,700 characters on the median asset and
  // carries block heights and archetype-reclassification history, so the
  // summary layer states only what was reviewed; the prose is "Review notes".
  const verdict = `Reviewed against ${review.sources.length} cited ${review.sources.length === 1 ? "source" : "sources"} as a ${archetypeLabel.toLowerCase()} mechanism.`;

  return (
    <div className="px-4 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        {archetypeBadge}
        <span className="font-mono text-[11px] text-muted-foreground">Reviewed {review.reviewedAt}</span>
      </div>
      <CollapsibleProse text={review.notes} verdict={verdict} className="mt-3 text-sm" />
      <EvidenceFooter className="mt-5" sources={review.sources} trailing={explainerLink} />
    </div>
  );
}
