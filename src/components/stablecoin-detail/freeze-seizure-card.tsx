"use client";

import { ReviewNotes } from "@/components/stablecoin-detail/collapsible-prose";
import { EvidenceRailCard } from "@/components/stablecoin-detail/evidence-rail-card";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import type { BlacklistabilityClientSummary } from "@/lib/stablecoin-detail-blacklistability-client";
import { cn } from "@/lib/utils";

/**
 * Whether this issuer can freeze or seize a holder's tokens at all, and the
 * sourced proof behind that finding — the review Pharos has published for every
 * tracked coin but never surfaced. The `BlacklistSection` below covers observed
 * freeze *usage*; this module covers the *power*.
 */
export function FreezeSeizureCard({ summary, frameless }: { summary?: BlacklistabilityClientSummary | null; frameless?: boolean }) {
  if (!summary) return null;

  // The status itself is the header chip; the grid carries only what the chip
  // does not say.
  const facts = [
    { key: "basis", label: "Basis", value: summary.basisLabel },
    ...(summary.upstreamLabel ? [{ key: "upstream", label: "Upstream", value: summary.upstreamLabel }] : []),
  ];

  return <EvidenceRailCard frameless={frameless} title="Freeze & seizure" ariaLabel="Freeze and seizure" badge={{ label: summary.statusLabel, className: cn("text-[11px] font-medium", summary.statusToneClass) }} evidence={{ sources: summary.sources.map((source) => ({ label: source.label, url: source.url })), trailing: summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined }}>
      <p className="text-xs leading-relaxed text-muted-foreground">{summary.statusNote}</p>
      <FactGrid aria-label="Freeze and seizure facts" items={facts} className="grid-cols-2" />
      {/* On-chain slot reads, block heights and the resolver's own narration
          are reviewer prose: they belong behind the disclosure, not the summary. */}
      <ReviewNotes>
        <p>{summary.evidence}</p>
        {summary.sourceFreeRationale ? <p>{summary.sourceFreeRationale}</p> : null}
      </ReviewNotes>
    </EvidenceRailCard>;
}
