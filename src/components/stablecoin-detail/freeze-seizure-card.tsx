"use client";

import { CollapsibleProse } from "@/components/stablecoin-detail/collapsible-prose";
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

  const facts = [
    { key: "status", label: "Freeze power", value: summary.statusLabel },
    { key: "basis", label: "Basis", value: summary.basisLabel },
    ...(summary.upstreamLabel ? [{ key: "upstream", label: "Upstream", value: summary.upstreamLabel }] : []),
  ];

  return <EvidenceRailCard frameless={frameless} title="Freeze & seizure" ariaLabel="Freeze and seizure" badge={{ label: summary.statusLabel, className: cn("text-[11px] font-medium", summary.statusToneClass) }} evidence={{ sources: summary.sources.map((source) => ({ label: source.label, url: source.url })), trailing: summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined }}>
      <p className="text-xs leading-relaxed text-muted-foreground">{summary.statusNote}</p>
      {/* Access-review evidence routinely runs past 400 characters (on-chain
          slot reads at a fixed block), so it folds to a lead. */}
      <CollapsibleProse text={summary.evidence} className="text-xs" variant="rail" />
      <FactGrid aria-label="Freeze and seizure facts" items={facts} className="grid-cols-2" />
      {summary.sourceFreeRationale ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{summary.sourceFreeRationale}</p>
      ) : null}
    </EvidenceRailCard>;
}
