"use client";

import { Badge } from "@/components/ui/badge";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import type { ReportCardGrade } from "@shared/types";

export function GradeBadge({
  grade,
  score,
  size = "sm",
}: {
  grade: ReportCardGrade;
  score: number | null;
  size?: "sm" | "lg";
}) {
  const colorClasses = REPORT_CARD_GRADE_COLORS[grade];
  const sizeClasses =
    size === "lg" ? "text-2xl px-4 py-2 font-bold" : "text-xs px-2 py-0.5 font-medium";

  return (
    <Badge variant="outline" className={`${colorClasses} ${sizeClasses}`} aria-label={`Safety grade ${grade}${score !== null ? `, score ${score}` : ""}`}>
      {grade}
      {score !== null && (
        <span className="ml-1 opacity-70" aria-hidden="true">({score})</span>
      )}
    </Badge>
  );
}
