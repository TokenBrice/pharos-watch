"use client";

import { FlowEventFeed } from "@/components/flow-event-feed";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { FlowSummaryCard } from "@/components/flow-summary-card";
import { Card } from "@/components/ui/card";

interface FlowsSectionProps {
  stablecoinId: string;
  hasFlows: boolean;
}

export function FlowsSection({ stablecoinId, hasFlows }: FlowsSectionProps) {
  if (!hasFlows) return null;

  return (
    <>
      <section id="flows">
        <FlowSummaryCard stablecoinId={stablecoinId} />
      </section>

      <section id="flow-history">
        <Card className="p-4">
          <div className="mb-3">
            <DetailSectionTitle>Mint &amp; Burn Flow History</DetailSectionTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Counted economic flow only. Excludes bridge transfers, review-required burns, and atomic roundtrips.
            </p>
          </div>
          <FlowEventFeed stablecoinId={stablecoinId} limit={10} scope="counted" />
        </Card>
      </section>
    </>
  );
}
