"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink, FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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

function ArchetypeBadge({ review }: { review: MechanismReviewView }) {
  return (
    <Badge
      variant="outline"
      className="border-border/60 bg-muted/30 text-[11px] font-medium text-muted-foreground"
    >
      {getMechanismArchetypeLabel(review.archetype)}
    </Badge>
  );
}

function SourceList({ review }: { review: MechanismReviewView }) {
  return (
    <>
      <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        Sources ({review.sources.length})
      </h3>
      <ul className="mt-2 space-y-2">
        {review.sources.map((source) => (
          <li key={source.url} className="flex min-w-0 gap-2 text-xs leading-relaxed">
            <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring min-w-0 break-words rounded-sm text-frost-blue underline-offset-2 hover:underline"
            >
              {source.label}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

function ExplainerLink({ review }: { review: MechanismReviewView }) {
  return (
    <Link
      href={getMechanismExplainerPath(review.archetype)}
      className="pharos-focus-ring rounded-sm text-xs text-frost-blue underline-offset-2 hover:underline"
    >
      How {getMechanismArchetypeLabel(review.archetype).toLowerCase()} stablecoins work
    </Link>
  );
}

/**
 * Rail treatment. Reviewed notes run to ~1,700 characters on the median asset
 * and past 6,000 on the longest, which does not fit a 22rem column, so the
 * prose clamps and one control opens both the full text and the sources.
 */
function CompactMechanismReview({ review }: { review: MechanismReviewView }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="pharos-card-shell overflow-hidden" aria-label="Mechanism review">
      <div className="flex items-center justify-between gap-3 px-4 py-3.5">
        <h2 className="text-sm font-medium text-muted-foreground">Mechanism review</h2>
        <span className="inline-flex h-6 items-center rounded-full bg-muted/70 px-2 font-mono text-xs font-medium text-muted-foreground">
          {review.reviewedAt}
        </span>
      </div>

      <div className="px-4 pb-4">
        <ArchetypeBadge review={review} />
        <p
          className={cn(
            "mt-3 whitespace-pre-line text-xs leading-relaxed text-muted-foreground",
            !open && "line-clamp-6",
          )}
        >
          {review.notes}
        </p>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="pharos-focus-ring mt-2 inline-flex min-h-7 items-center gap-1 rounded-sm text-[11px] font-medium text-frost-blue"
        >
          {open ? "Show less" : `Show more · ${review.sources.length} sources`}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </div>

      {open ? (
        <div className="border-t border-border/50 px-4 py-4">
          <SourceList review={review} />
        </div>
      ) : null}

      <div className="border-t border-border/50 px-4 py-3">
        <ExplainerLink review={review} />
      </div>
    </section>
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
 */
export function MechanismReviewPanel({
  review,
  compact = false,
}: {
  review: MechanismReviewView | null;
  compact?: boolean;
}) {
  if (review === null) return null;
  if (compact) return <CompactMechanismReview review={review} />;

  return (
    <Card id="mechanism-review" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT, "xl:hidden")}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex min-w-0 items-center gap-2">
          <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>Mechanism review</DetailSectionTitle>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <ArchetypeBadge review={review} />
          <span className="font-mono text-[11px] text-muted-foreground">Reviewed {review.reviewedAt}</span>
        </div>
      </CardHeader>
      <CardContent className={DETAIL_MODULE_BODY_CLASS}>
        <p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
          {review.notes}
        </p>

        <div className="mt-5 border-t border-border/40 pt-4">
          <SourceList review={review} />
        </div>

        <p className="mt-4">
          <ExplainerLink review={review} />
        </p>
      </CardContent>
    </Card>
  );
}
