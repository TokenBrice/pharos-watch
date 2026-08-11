"use client";

import { Badge } from "@/components/ui/badge";
import { CollapsibleProse } from "@/components/stablecoin-detail/collapsible-prose";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
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

  return (
    <RailCard
      frameless={frameless}
      title="Freeze & seizure"
      ariaLabel="Freeze and seizure"
      trailing={
        <Badge variant="outline" className={cn("text-[11px] font-medium", summary.statusToneClass)}>
          {summary.statusLabel}
        </Badge>
      }
    >
      <div className="space-y-3 px-4 pb-4">
        <p className="text-xs leading-relaxed text-muted-foreground">{summary.statusNote}</p>
        {/* Access-review evidence routinely runs past 400 characters (on-chain
            slot reads at a fixed block), so it folds to a lead. */}
        <CollapsibleProse text={summary.evidence} className="text-xs" variant="rail" />
        <FactGrid aria-label="Freeze and seizure facts" items={facts} className="grid-cols-2" />
        {summary.sourceFreeRationale ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{summary.sourceFreeRationale}</p>
        ) : null}
        <EvidenceFooter
          sources={summary.sources.map((source) => ({ label: source.label, url: source.url }))}
          trailing={summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined}
        />
      </div>
    </RailCard>
  );
}
