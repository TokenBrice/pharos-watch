"use client";

import Link from "next/link";
import { ExternalLink, FlaskConical } from "lucide-react";
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

/**
 * The reviewed evidence behind the Backing pillar's mechanism component scores.
 * Those scores render in the report card above; this section is the "why we
 * believe this" — dated analyst prose and the sources it was measured against.
 */
export function MechanismReviewPanel({ review }: { review: MechanismReviewView | null }) {
  if (review === null) return null;

  return (
    <Card id="mechanism-review" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT)}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex min-w-0 items-center gap-2">
          <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>Mechanism review</DetailSectionTitle>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="border-border/60 bg-muted/30 text-[11px] font-medium text-muted-foreground"
          >
            {getMechanismArchetypeLabel(review.archetype)}
          </Badge>
          <span className="font-mono text-[11px] text-muted-foreground">Reviewed {review.reviewedAt}</span>
        </div>
      </CardHeader>
      <CardContent className={DETAIL_MODULE_BODY_CLASS}>
        <p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
          {review.notes}
        </p>

        <div className="mt-5 border-t border-border/40 pt-4">
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
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          <Link
            href={getMechanismExplainerPath(review.archetype)}
            className="pharos-focus-ring rounded-sm text-frost-blue underline-offset-2 hover:underline"
          >
            How {getMechanismArchetypeLabel(review.archetype).toLowerCase()} stablecoins work
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
