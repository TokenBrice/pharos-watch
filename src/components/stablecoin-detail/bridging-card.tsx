"use client";

import { CollapsibleProse } from "@/components/stablecoin-detail/collapsible-prose";
import { EvidenceRailCard } from "@/components/stablecoin-detail/evidence-rail-card";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import type { BridgeRouteRiskClientSummary } from "@/lib/stablecoin-detail-bridge-client";
import { cn } from "@/lib/utils";

/**
 * The bridging setup the Safety Score and AI summaries already reference,
 * finally drawn as its own module: reviewed route-risk tier, the analyst
 * summary, and the route/chain facts, in the rail-card grammar. Renders
 * nothing when no bridge review exists (most single-chain coins).
 */
export function BridgingCard({ summary, frameless }: { summary?: BridgeRouteRiskClientSummary | null; frameless?: boolean }) {
  if (!summary) return null;

  const facts = [
    { key: "routes", label: "Routes", value: String(summary.routeCount) },
    { key: "chains", label: "Chains", value: String(summary.chainCount) },
    { key: "confidence", label: "Confidence", value: summary.confidenceLabel },
    ...(summary.thirdPartyRouteCount > 0
      ? [{ key: "third-party", label: "Third-party", value: String(summary.thirdPartyRouteCount) }]
      : []),
  ];

  return <EvidenceRailCard frameless={frameless} title="Bridging" badge={{ label: summary.tierLabel, className: cn("text-[11px] font-medium", summary.tierToneClass) }} evidence={{ sources: summary.sources.map((source) => ({ label: source.label, url: source.url })), trailing: summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined }}>
      {/* 63 of 272 reviewed bridge summaries run past 400 characters (DAI ~2,000). */}
      <CollapsibleProse text={summary.summary} className="text-xs" variant="rail" />
      {/* No `grid-cols-3` override: it stranded the fourth fact
          (`Third-party`) alone on a second row. Auto-fit wraps 4 as 2×2. */}
      <FactGrid aria-label="Bridge route facts" items={facts} />
    </EvidenceRailCard>;
}
