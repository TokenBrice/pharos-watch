"use client";

import { FlowEventFeed } from "@/components/flow-event-feed";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { FlowSummaryCard } from "@/components/flow-summary-card";
import { MethodologyLabel } from "@/components/methodology-hint";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

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
      <Card className={DETAIL_MODULE_SHELL_CLASS}>
        <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
          <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>
            <MethodologyLabel topic="mintBurnFlows">Mint &amp; Burn Flow History</MethodologyLabel>
          </DetailSectionTitle>
        </CardHeader>
        <CardContent className={`${DETAIL_MODULE_BODY_CLASS} space-y-4`}>
          <p className="mt-1 text-sm text-muted-foreground">
            Counted economic flow only. Excludes bridge transfers, review-required burns, and atomic roundtrips.
          </p>
          <FlowEventFeed stablecoinId={stablecoinId} limit={10} scope="counted" />
        </CardContent>
      </Card>
    </section>
  );
}
