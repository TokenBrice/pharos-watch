"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useBluechipRatings } from "@/hooks/api-hooks";
import { BLUECHIP_REPORT_BASE, GRADE_ORDER } from "@/lib/bluechip";
import { ScoreBadgeWrapper, type ScoreBadgeWrapperVariant } from "@/components/score-badge-wrapper";
import type { MethodologyContextKey } from "@/lib/methodology-context";
import { SAFETY_SCORE_VERSION_LABEL } from "@shared/lib/safety-score-version";

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

/**
 * Parses Bluechip's `dateOfRating` (e.g. "2024-08-15") into a "since YYYY-MM"
 * editorial kicker. Returns `null` for missing/malformed dates so the kicker
 * silently drops rather than rendering as broken copy.
 */
function formatSinceKicker(dateOfRating: string | undefined | null): string | null {
  if (!dateOfRating) return null;
  const match = /^(\d{4})-(\d{2})/.exec(dateOfRating);
  if (!match) return null;
  return `${match[1]}-${match[2]}`;
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

  const since = formatSinceKicker(rating.dateOfRating);

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

  const wrappedLink = versionTopic ? (
    <ScoreBadgeWrapper topic={versionTopic} variant={versionVariant}>
      {link}
    </ScoreBadgeWrapper>
  ) : (
    link
  );

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <Link
        href="/about/bluechip/"
        aria-label="About Pharos Bluechip — gated rating designation"
        title="What Pharos Bluechip means"
        className="pharos-focus-ring inline-flex items-center rounded-sm font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground"
      >
        Pharos Bluechip{since ? ` · since ${since}` : ""}
      </Link>
      {wrappedLink}
      <span
        aria-hidden="true"
        className="font-mono text-[10px] text-muted-foreground/70"
      >
        Methodology {SAFETY_SCORE_VERSION_LABEL}
      </span>
    </span>
  );
}
