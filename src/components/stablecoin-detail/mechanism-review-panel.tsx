"use client";

import { useState } from "react";
import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CollapsibleProse } from "@/components/stablecoin-detail/collapsible-prose";
import { InlineDisclosureToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { RailCard, ReviewedStamp } from "@/components/stablecoin-detail/rail-card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import {
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import { cn } from "@/lib/utils";

/**
 * Rail-only prose treatment: a `line-clamp` fold rather than the shared
 * `prose-lead` string cut. Deliberate and documented in `prose-lead.ts` — the
 * string cut exists because one *full-width* clamped line already carries ~150
 * characters, which is not true of a 22rem column, where three clamped lines
 * are the right budget.
 */
function ClampedRailProse({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p
        className={cn(
          "mt-3 whitespace-pre-line text-xs leading-relaxed text-muted-foreground",
          !open && "line-clamp-3",
        )}
      >
        {text}
      </p>
      <InlineDisclosureToggle
        open={open}
        onToggle={() => setOpen((value) => !value)}
        collapsedLabel="Read more"
        className="mt-2"
      />
    </>
  );
}

/**
 * The reviewed evidence behind the Backing pillar's mechanism component scores.
 * Those scores render in the report card; this is the "why we believe this" —
 * dated analyst prose and the sources it was measured against.
 *
 * Lives in the summary rail at `xl+` (`compact`) and in the Context zone below
 * `xl`, the same split `#price` and `#coin-timeline` use, so narrow viewports
 * still get the review.
 *
 * Both treatments are built from one set of locals and branch only on the
 * shell (`RailCard` vs `Card`), so the archetype badge, explainer link, review
 * stamp and evidence footer cannot drift between them.
 */
export function MechanismReviewPanel({
  review,
  compact = false,
}: {
  review: MechanismReviewView | null;
  compact?: boolean;
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
        trailing={<ReviewedStamp date={review.reviewedAt} />}
      >
        <div className="px-4 pb-4">
          {archetypeBadge}
          <ClampedRailProse text={review.notes} />
        </div>

        <div className="px-4 pb-4">
          <EvidenceFooter sources={review.sources} trailing={explainerLink} />
        </div>
      </RailCard>
    );
  }

  return (
    <Card id="mechanism-review" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT, "xl:hidden")}>
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
