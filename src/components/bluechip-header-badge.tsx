"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { useBluechipRatings } from "@/hooks/api-hooks";
import { BLUECHIP_REPORT_BASE, GRADE_ORDER, bluechipObservationText } from "@/lib/bluechip";
import { ScoreBadgeWrapper, type ScoreBadgeWrapperVariant } from "@/components/score-badge-wrapper";
import type { MethodologyContextKey } from "@/lib/methodology-context";
import { SCORE_TIER_4_CLASSES } from "@shared/lib/classification";

interface BluechipHeaderBadgeProps {
  stablecoinId: string;
  /**
   * When set, wraps the badge in `<ScoreBadgeWrapper>` for the
   * methodology-aware tooltip. Bluechip has no methodology version, so the
   * inline suffix is a no-op even in suffix mode.
   */
  versionTopic?: MethodologyContextKey;
  versionVariant?: ScoreBadgeWrapperVariant;
}

export function BluechipHeaderBadge({ stablecoinId, versionTopic, versionVariant }: BluechipHeaderBadgeProps) {
  const { data: ratingsMap } = useBluechipRatings();
  const rating = ratingsMap?.[stablecoinId];
  // Only a future clock depends on now; a successful observation date never ages into a label.
  const [nowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  if (!rating) return null;

  const observationText = bluechipObservationText(rating.lastObservedAt, nowSeconds);
  const order = GRADE_ORDER[rating.grade] ?? 0;
  const gradeColor =
    order >= 10 ? SCORE_TIER_4_CLASSES.t80.text :
    order >= 7  ? SCORE_TIER_4_CLASSES.t60.text :
    order >= 4  ? SCORE_TIER_4_CLASSES.t40.text :
                  SCORE_TIER_4_CLASSES.t0.text;

  const link = (
    <a
      href={`${BLUECHIP_REPORT_BASE}/${rating.slug}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Bluechip rating: ${rating.grade} · ${observationText} (via bluechip.org)`}
      title={`${observationText} · View the external Bluechip methodology`}
      className="pharos-focus-ring inline-flex min-h-11 max-w-full flex-wrap items-center gap-x-1.5 rounded-md px-1 py-1 text-sm transition-colors hover:text-foreground lg:min-h-0"
    >
      <span className="text-muted-foreground font-medium">Bluechip:</span>
      <span className={`font-mono font-semibold ${gradeColor}`}>{rating.grade}</span>
      <ExternalLink className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
    </a>
  );

  const wrappedLink = versionTopic ? (
    <ScoreBadgeWrapper topic={versionTopic} variant={versionVariant}>
      {link}
    </ScoreBadgeWrapper>
  ) : (
    link
  );

  return wrappedLink;
}
