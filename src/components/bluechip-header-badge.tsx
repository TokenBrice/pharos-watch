"use client";

import { ExternalLink } from "lucide-react";
import { useBluechipRatings } from "@/hooks/api-hooks";
import { BLUECHIP_REPORT_BASE, GRADE_ORDER } from "@/lib/bluechip";

export function BluechipHeaderBadge({ stablecoinId }: { stablecoinId: string }) {
  const { data: ratingsMap } = useBluechipRatings();
  const rating = ratingsMap?.[stablecoinId];
  if (!rating) return null;

  const order = GRADE_ORDER[rating.grade] ?? 0;
  const gradeColor =
    order >= 10 ? "text-emerald-700 dark:text-emerald-400" :
    order >= 7  ? "text-blue-700 dark:text-blue-400" :
    order >= 4  ? "text-amber-700 dark:text-amber-400" :
                  "text-red-700 dark:text-red-400";

  return (
    <a
      href={`${BLUECHIP_REPORT_BASE}/${rating.slug}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Bluechip external rating ${rating.grade}`}
      className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 py-1 text-sm transition-colors hover:text-foreground lg:min-h-0"
    >
      <span className="text-muted-foreground font-medium">Bluechip:</span>
      <span className={`font-mono font-semibold ${gradeColor}`}>{rating.grade}</span>
      <ExternalLink className="h-3 w-3 text-muted-foreground" />
    </a>
  );
}
