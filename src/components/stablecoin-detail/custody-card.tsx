// src/components/stablecoin-detail/custody-card.tsx
"use client";

import { Badge } from "@/components/ui/badge";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import type { CustodyClientSummary } from "@/lib/stablecoin-detail-custody-client";
import { cn } from "@/lib/utils";

function ShareBar({ pct, barClassName }: { pct: number; barClassName?: string }) {
  const width = Math.max(0, Math.min(100, pct));
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <div className={cn("h-full rounded-full bg-foreground/40", barClassName)} style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * Who holds the reserves, under what legal structure: the reviewed
 * `custodyProfile` (provider roster with share bars, segregation /
 * bankruptcy-remoteness / rehypothecation facts) in the rail-card grammar.
 * Renders nothing when no custody review exists.
 */
export function CustodyCard({ summary, frameless }: { summary?: CustodyClientSummary | null; frameless?: boolean }) {
  if (!summary) return null;

  const facts: FactGridItem[] = [
    { key: "segregation", label: "Segregation", value: summary.segregationLabel },
    { key: "bankruptcy", label: "Bankr. remote", value: summary.bankruptcyRemotenessLabel },
    {
      key: "rehypothecation",
      label: "Rehypothecation",
      value: summary.rehypothecationLabel,
      ...(summary.rehypothecationToneClass ? { valueClassName: summary.rehypothecationToneClass } : {}),
    },
    { key: "providers", label: "Providers", value: String(summary.providers.length) },
    { key: "confidence", label: "Confidence", value: summary.confidenceLabel },
  ];

  return (
    <RailCard
      frameless={frameless}
      title="Custody"
      ariaLabel="Custody"
      trailing={
        <Badge variant="outline" className={cn("text-[11px] font-medium", summary.postureToneClass)}>
          {summary.postureLabel}
        </Badge>
      }
    >
      <div className="space-y-3 px-4 pb-4">
        <p className="text-xs leading-relaxed text-muted-foreground">{summary.summary}</p>
        {summary.providers.length > 0 || summary.undisclosedSharePct != null ? (
          <ul aria-label="Custody providers" className="space-y-2.5">
            {summary.providers.map((provider) => (
              <li key={provider.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 break-words text-xs text-foreground">{provider.name}</span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {provider.sharePct != null ? `${provider.sharePct}%` : "—"}
                  </span>
                </div>
                <div className="text-[10px] uppercase leading-tight tracking-[0.14em] text-muted-foreground">
                  {provider.roleLabel}
                  {provider.jurisdiction ? ` · ${provider.jurisdiction}` : ""}
                </div>
                {provider.sharePct != null ? <ShareBar pct={provider.sharePct} /> : null}
              </li>
            ))}
            {summary.undisclosedSharePct != null ? (
              <li>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-amber-700 dark:text-amber-400">Undisclosed</span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-amber-700 dark:text-amber-400">
                    {summary.undisclosedSharePct}%
                  </span>
                </div>
                <ShareBar pct={summary.undisclosedSharePct} barClassName="bg-amber-500/50" />
              </li>
            ) : null}
          </ul>
        ) : null}
        {/* No `grid-cols-3` override: forcing three tracks into the 22rem rail
            clipped the `Rehypothecation` label at the card edge. FactGrid's
            auto-fit resolves to two columns here. */}
        <FactGrid aria-label="Custody facts" items={facts} />
        <EvidenceFooter
          sources={summary.sources.map((source) => ({ label: source.label, url: source.url }))}
          sourcesFootnote={
            summary.uncertainty ? <p className="text-muted-foreground/80">{summary.uncertainty}</p> : null
          }
          trailing={summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined}
        />
      </div>
    </RailCard>
  );
}
