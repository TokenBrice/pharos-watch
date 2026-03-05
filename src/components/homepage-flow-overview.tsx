"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { FlowBrrrOverview } from "@/components/flow-brrr-overview";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";

export function HomepageFlowOverview() {
  const {
    data: summaryData,
    isLoading: isSummaryLoading,
    error: summaryError,
    refetch: refetchSummary,
  } = useMintBurnFlows(24);
  const {
    data: weeklyData,
    error: weeklyError,
    refetch: refetchWeekly,
  } = useMintBurnFlows(168);

  const error = summaryError ?? weeklyError;
  const hasData = !!summaryData;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Mint/Burn Flow Snapshot</h2>
        <Link
          href="/flows/"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          View full tracker
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <QueryErrorNotice
        error={error}
        hasData={hasData}
        onRetry={() => {
          void refetchSummary();
          void refetchWeekly();
        }}
      />

      {(hasData || isSummaryLoading) && (
        <FlowBrrrOverview
          gauge={summaryData?.gauge ?? null}
          coins={summaryData?.coins ?? []}
          weeklyHourly={weeklyData?.hourly}
          isLoading={!summaryData && isSummaryLoading}
        />
      )}
    </section>
  );
}
