"use client";

import { Badge } from "@/components/ui/badge";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
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
    <section className="pharos-card-shell overflow-hidden" aria-label="Bridging">
      <div className="flex items-center justify-between gap-3 px-4 py-3.5">
        <h2 className={DETAIL_MODULE_TITLE_CLASS}>Bridging</h2>
        <Badge variant="outline" className={cn("text-[11px] font-medium", summary.tierToneClass)}>
          {summary.tierLabel}
        </Badge>
      </div>
      <div className="space-y-3 px-4 pb-4">
        <p className="text-xs leading-relaxed text-muted-foreground">{summary.summary}</p>
        <FactGrid aria-label="Bridge route facts" items={facts} className="grid-cols-3" />
        <EvidenceFooter
          sources={summary.sources.map((source) => ({ label: source.label, url: source.url }))}
          trailing={summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined}
        />
      </div>
    </section>
  );
}
