"use client";

import { useBluechipRatings, useReportCardsV9 } from "@/hooks/api-hooks";

export function BluechipActiveList() {
  const { data: ratingsMap, isLoading, error } = useBluechipRatings();
  const {
    data: reportCardsData,
    isLoading: reportCardsLoading,
    error: reportCardsError,
  } = useReportCardsV9();

  if (isLoading || reportCardsLoading) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
        Loading active Bluechip roster…
      </p>
    );
  }

  if (error || reportCardsError || !ratingsMap || !reportCardsData) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
        Bluechip roster temporarily unavailable.
      </p>
    );
  }

  return (
    <p className="font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
      Bluechip roster temporarily unavailable while the V9 grade floor is under review.
    </p>
  );
}
