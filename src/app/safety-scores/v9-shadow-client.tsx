"use client";

import { ReportCardsV9ShadowRenderer } from "@/components/report-card-v9";
import { useReportCardsV9 } from "@/hooks/api-hooks";

/**
 * Deliberately not imported by the public page. This end-to-end client keeps
 * the V9 parser and renderer executable for review without selecting V9 for
 * any user-facing route.
 */
export function ReportCardsV9ShadowClient() {
  const { data, isLoading, error } = useReportCardsV9();

  if (isLoading) {
    return <div className="h-40 animate-pulse rounded-md bg-muted/40" aria-label="Loading safety scores" />;
  }
  if (error || !data) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        Safety data is temporarily unavailable.
      </p>
    );
  }
  return <ReportCardsV9ShadowRenderer response={data} expectedIdentity={data.safetyScoreIdentity} />;
}
