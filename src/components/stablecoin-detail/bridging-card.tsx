"use client";

import { Badge } from "@/components/ui/badge";
import { CollapsibleProse } from "@/components/stablecoin-detail/collapsible-prose";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import type { BridgeRouteRiskClientSummary } from "@/lib/stablecoin-detail-bridge-client";
import { cn } from "@/lib/utils";

/**
 * The bridging setup the Safety Score and AI summaries already reference,
 * finally drawn as its own module: reviewed route-risk tier, the analyst
 * summary, and the route/chain facts, in the rail-card grammar. Renders
 * nothing when no bridge review exists (most single-chain coins).
 */
export function BridgingCard({ summary }: { summary?: BridgeRouteRiskClientSummary | null }) {
  if (!summary) return null;

  const facts = [
    { key: "routes", label: "Routes", value: String(summary.routeCount) },
    { key: "chains", label: "Chains", value: String(summary.chainCount) },
    { key: "confidence", label: "Confidence", value: summary.confidenceLabel },
    ...(summary.thirdPartyRouteCount > 0
      ? [{ key: "third-party", label: "Third-party", value: String(summary.thirdPartyRouteCount) }]
      : []),
  ];

  return (
    <RailCard
      title="Bridging"
      ariaLabel="Bridging"
      trailing={
        <Badge variant="outline" className={cn("text-[11px] font-medium", summary.tierToneClass)}>
          {summary.tierLabel}
        </Badge>
      }
    >
      <div className="space-y-3 px-4 pb-4">
        {/* 63 of 272 reviewed bridge summaries run past 400 characters (DAI ~2,000). */}
        <CollapsibleProse text={summary.summary} className="text-xs" />
        <FactGrid aria-label="Bridge route facts" items={facts} className="grid-cols-3" />
        <EvidenceFooter
          sources={summary.sources.map((source) => ({ label: source.label, url: source.url }))}
          trailing={summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined}
        />
      </div>
    </RailCard>
  );
}
