"use client";

import { ReviewNotes } from "@/components/stablecoin-detail/collapsible-prose";
import { EvidenceRailCard } from "@/components/stablecoin-detail/evidence-rail-card";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import type { BridgeRouteRiskClientSummary } from "@/lib/stablecoin-detail-bridge-client";
import { cn } from "@/lib/utils";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The bridging setup the Safety Score and AI summaries already reference,
 * drawn as its own module: reviewed route-risk tier, route/chain facts, and
 * the analyst summary behind "Review notes". The verdict line is generated
 * from the structured tier and counts, never clipped from the authored
 * summary (63 of 272 run past 400 characters). Renders nothing when no bridge
 * review exists (most single-chain coins).
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
  const verdict = `${summary.tierLabel} across ${plural(summary.routeCount, "reviewed route")} on ${plural(summary.chainCount, "chain")}${
    summary.thirdPartyRouteCount > 0 ? `, ${summary.thirdPartyRouteCount} third-party` : ""
  }.`;

  return <EvidenceRailCard frameless={frameless} title="Bridging" badge={{ label: summary.tierLabel, className: cn("text-[11px] font-medium", summary.tierToneClass) }} evidence={{ sources: summary.sources.map((source) => ({ label: source.label, url: source.url })), trailing: summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined }}>
      <p className="text-xs leading-relaxed text-muted-foreground">{verdict}</p>
      {/* No `grid-cols-3` override: it stranded the fourth fact
          (`Third-party`) alone on a second row. Two tracks wrap 4 as 2×2. */}
      <FactGrid aria-label="Bridge route facts" items={facts} />
      <ReviewNotes>
        <p className="whitespace-pre-line">{summary.summary}</p>
      </ReviewNotes>
    </EvidenceRailCard>;
}
