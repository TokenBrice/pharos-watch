"use client";

import { GradeBadge } from "@/components/grade-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { useSafetyScoreHistory } from "@/hooks/use-safety-score-history";
import type { SafetyScoreHistoryPoint } from "@shared/types";

export function formatSafetyScoreHistoryDate(date: number): string {
  return new Date(date * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function describeSafetyScoreTransition(point: SafetyScoreHistoryPoint): string {
  if (point.prevGrade == null) {
    return "Initial grade";
  }
  return `${point.prevGrade} -> ${point.grade}`;
}

interface SafetyScoreHistorySectionProps {
  stablecoinId: string;
}

export function SafetyScoreHistorySection({ stablecoinId }: SafetyScoreHistorySectionProps) {
  const { data, isLoading, error } = useSafetyScoreHistory(stablecoinId, 3650);

  if (isLoading) {
    return null;
  }

  if (error) {
    return <QueryErrorNotice error={error} />;
  }

  const history = data ?? [];
  if (history.length === 0) {
    return null;
  }

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-1">
        <CardTitle as="h3" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Grade History
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {history.map((point) => (
            <li
              key={`${point.date}-${point.grade}`}
              className="rounded-lg border px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{formatSafetyScoreHistoryDate(point.date)}</span>
                <GradeBadge grade={point.grade} score={point.score} />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{describeSafetyScoreTransition(point)}</p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
