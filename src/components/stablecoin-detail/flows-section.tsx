"use client";

import { FlowEventFeed } from "@/components/flow-event-feed";
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
            <h2 className="text-lg font-semibold tracking-tight">Mint &amp; Burn Flow History</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Counted economic flow only. Excludes bridge burns, review-required burns, and atomic roundtrips.
            </p>
          </div>
          <FlowEventFeed stablecoinId={stablecoinId} limit={10} scope="counted" />
        </Card>
      </section>
    </>
  );
}
