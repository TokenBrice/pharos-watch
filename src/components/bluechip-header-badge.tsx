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
      className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors hover:bg-accent lg:min-h-9 lg:px-2.5 lg:py-0.5"
    >
      <span className="text-muted-foreground font-medium">bluechip</span>
      <span className={`font-mono font-bold ${gradeColor}`}>{rating.grade}</span>
      <ExternalLink className="h-2.5 w-2.5 text-muted-foreground" />
    </a>
  );
}
