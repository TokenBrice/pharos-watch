"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useBluechipRatings } from "@/hooks/api-hooks";
import { BLUECHIP_REPORT_BASE, GRADE_ORDER } from "@/lib/bluechip";
import { ScoreBadgeWrapper, type ScoreBadgeWrapperVariant } from "@/components/score-badge-wrapper";
import type { MethodologyContextKey } from "@/lib/methodology-context";
import { SCORE_TIER_4_CLASSES } from "@shared/lib/classification";
import { BLUECHIP_OBSERVATION_MAX_AGE_SEC, bluechipObservationLabel } from "@shared/lib/bluechip-freshness";

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
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const lastObservedAt = rating?.lastObservedAt;
  useEffect(() => {
    let timer: number;
    const tick = () => {
      const now = Date.now();
      setNowSeconds(Math.floor(now / 1000));
      if (lastObservedAt == null) return;
      const observedAtMs = lastObservedAt * 1000;
      const staleAtMs = (lastObservedAt + BLUECHIP_OBSERVATION_MAX_AGE_SEC + 1) * 1000;
      const nextBoundary = observedAtMs > now ? observedAtMs : staleAtMs;
      if (nextBoundary > now) timer = window.setTimeout(tick, Math.min(nextBoundary - now, 2_147_483_647));
    };
    // Re-anchor when the row refreshes, then wake only at observation boundaries.
    timer = window.setTimeout(tick, 0);
    return () => window.clearTimeout(timer);
  }, [lastObservedAt]);
  if (!rating) return null;

  const observationLabel = bluechipObservationLabel(rating, nowSeconds);
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
      aria-label={`Bluechip rating: ${rating.grade}${observationLabel ? ` · ${observationLabel}` : ""} (via bluechip.org)`}
      title="View the external Bluechip methodology"
      className="pharos-focus-ring inline-flex min-h-11 max-w-full flex-wrap items-center gap-x-1.5 rounded-md px-1 py-1 text-sm transition-colors hover:text-foreground lg:min-h-0"
    >
      <span className="text-muted-foreground font-medium">Bluechip:</span>
      <span className={`font-mono font-semibold ${gradeColor}`}>{rating.grade}</span>
      {observationLabel && <span className="text-muted-foreground text-xs">({observationLabel})</span>}
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
