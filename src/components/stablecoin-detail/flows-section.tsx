"use client";

import { FlowEventFeed } from "@/components/flow-event-feed";
import { DetailModuleCard } from "@/components/stablecoin-detail/module-title";
import { FlowSummaryCard } from "@/components/flow-summary-card";
import { MethodologyLabel } from "@/components/methodology-hint";

interface FlowsSectionProps {
  stablecoinId: string;
  hasFlows: boolean;
}

export function FlowsSection({ stablecoinId, hasFlows }: FlowsSectionProps) {
  if (!hasFlows) return null;

  return (
    <section id="flows">
      <FlowSummaryCard stablecoinId={stablecoinId} />
    </section>
  );
}

interface FlowHistorySectionProps {
  stablecoinId: string;
}

export function FlowHistorySection({ stablecoinId }: FlowHistorySectionProps) {
  return (
    <section id="flow-history">
      <DetailModuleCard
        title={<MethodologyLabel topic="mintBurnFlows">Mint &amp; Burn Flow History</MethodologyLabel>}
        bodyClassName="space-y-4"
      >
          <p className="mt-1 text-sm text-muted-foreground">
            Counted economic flow only. Excludes bridge transfers, review-required burns, and atomic roundtrips.
          </p>
          <FlowEventFeed stablecoinId={stablecoinId} limit={10} scope="counted" />
      </DetailModuleCard>
    </section>
  );
}
