"use client";

import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CollapsibleProse } from "@/components/stablecoin-detail/collapsible-prose";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
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
 * Lives in the summary rail at `xl+` (`compact`) and in the Context zone below
 * `xl`, the same split `#price` and `#coin-timeline` use, so narrow viewports
 * still get the review. Neither treatment carries an anchor id or a breakpoint
 * class: the in-flow copy mounts inside the `xl:hidden` `RailCopyFold` band
 * that owns `#mechanism-review` and the visibility gate.
 *
 * Both treatments are built from one set of locals and branch only on the
 * shell (`RailCard` vs `Card`), so the archetype badge, explainer link, review
 * stamp and evidence footer cannot drift between them.
 */
export function MechanismReviewPanel({
  review,
  compact = false,
  embedded = false,
}: {
  review: MechanismReviewView | null;
  compact?: boolean;
  /** Body-only render inside the `RailCopyFold` band (no shell, no title). */
  embedded?: boolean;
}) {
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

  if (compact) {
    return (
      <RailCard
        title="Mechanism review"
        ariaLabel="Mechanism review"
        trailing={archetypeBadge}
      >
        <div className="px-4 pb-4">
          <CollapsibleProse text={review.notes} className="mt-3 whitespace-pre-line text-xs" variant="rail" toggleClassName="mt-2" />
        </div>

        <div className="px-4 pb-4">
          <EvidenceFooter sources={review.sources} trailing={`Reviewed ${review.reviewedAt}`}>
            {explainerLink}
          </EvidenceFooter>
        </div>
      </RailCard>
    );
  }

  // Body-only render for the `RailCopyFold` band, which already owns the
  // shell and the "Mechanism review" title; the archetype badge and reviewed
  // date move from the dropped header into the first body row.
  if (embedded) {
    return (
      <div className="px-4 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          {archetypeBadge}
          <span className="font-mono text-[11px] text-muted-foreground">Reviewed {review.reviewedAt}</span>
        </div>
        <CollapsibleProse
          text={review.notes}
          className="mt-3 whitespace-pre-line text-sm"
          collapsedLabel="Read the full review"
          toggleClassName="mt-3"
          size="md"
        />
        <EvidenceFooter className="mt-5" sources={review.sources} trailing={explainerLink} />
      </div>
    );
  }

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex min-w-0 items-center gap-2">
          <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>Mechanism review</DetailSectionTitle>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {archetypeBadge}
          <span className="font-mono text-[11px] text-muted-foreground">Reviewed {review.reviewedAt}</span>
        </div>
      </CardHeader>
      <CardContent className={DETAIL_MODULE_BODY_CLASS}>
        <CollapsibleProse
          text={review.notes}
          className="whitespace-pre-line text-sm"
          collapsedLabel="Read the full review"
          toggleClassName="mt-3"
          size="md"
        />

        <EvidenceFooter
          className="mt-5"
          sources={review.sources}
          trailing={explainerLink}
        />
      </CardContent>
    </Card>
  );
}
