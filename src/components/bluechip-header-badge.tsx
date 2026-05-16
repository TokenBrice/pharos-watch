"use client";

import { ExternalLink } from "lucide-react";
import { useBluechipRatings } from "@/hooks/api-hooks";
import { BLUECHIP_REPORT_BASE, GRADE_ORDER } from "@/lib/bluechip";
import { ScoreBadgeWrapper, type ScoreBadgeWrapperVariant } from "@/components/score-badge-wrapper";
import type { MethodologyContextKey } from "@/lib/methodology-context";

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
  if (!rating) return null;

  const order = GRADE_ORDER[rating.grade] ?? 0;
  const gradeColor =
    order >= 10 ? "text-emerald-700 dark:text-emerald-400" :
    order >= 7  ? "text-blue-700 dark:text-blue-400" :
    order >= 4  ? "text-amber-700 dark:text-amber-400" :
                  "text-red-700 dark:text-red-400";

  const link = (
    <a
      href={`${BLUECHIP_REPORT_BASE}/${rating.slug}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Bluechip rating: ${rating.grade} (via bluechip.org)`}
      title="View the external Bluechip methodology"
      className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 py-1 text-sm transition-colors hover:text-foreground lg:min-h-0"
    >
      <span className="text-muted-foreground font-medium">Bluechip:</span>
      <span className={`font-mono font-semibold ${gradeColor}`}>{rating.grade}</span>
      <ExternalLink className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
    </a>
  );

  if (versionTopic) {
    return (
      <ScoreBadgeWrapper topic={versionTopic} variant={versionVariant}>
        {link}
      </ScoreBadgeWrapper>
    );
  }
  return link;
}
