// src/components/stablecoin-detail/regulatory-standing-card.tsx
"use client";

import { Check, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import { CollapsibleProse } from "@/components/stablecoin-detail/collapsible-prose";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import type { RegulatoryStandingView } from "@/lib/regulatory-standing";
import { cn } from "@/lib/utils";

/**
 * The coin's regulatory standing on-page: GENIUS and MiCA status facts plus
 * the researched GENIUS obligations checklist, previously reduced to one
 * passport chip linking off to /compliance. Renders nothing when neither
 * regime has a curated profile.
 */
export function RegulatoryStandingCard({
  view,
  frameless,
  anchorTwin,
}: {
  view?: RegulatoryStandingView | null;
  frameless?: boolean;
  /** Anchor id the rail instance stands in for — `#jurisdiction`, owned by the
   *  `xl:hidden` in-flow fold (see `RailCard`). */
  anchorTwin?: string;
}) {
  if (!view) return null;

  return (
    <RailCard
      frameless={frameless}
      title="Regulatory standing"
      {...(anchorTwin ? { anchorTwin } : {})}
      ariaLabel="Regulatory standing"
      trailing={
        <Badge variant="outline" className={cn("text-[11px] font-medium", view.badgeToneClass)}>
          {view.badgeLabel}
        </Badge>
      }
    >
      <div className="space-y-3 px-4 pb-4">
        <CollapsibleProse text={view.summary} className="text-xs" variant="rail" />
        {view.regimes.map((regime) => (
          <div key={regime.key} className="space-y-2.5 border-t border-border/50 pt-3">
            <div className="text-[10px] font-medium uppercase leading-tight tracking-[0.14em] text-muted-foreground">
              {regime.regimeLabel}
            </div>
            <FactGrid aria-label={`${regime.regimeLabel} facts`} items={regime.facts} className="grid-cols-3" />
            {regime.checklist.length > 0 ? (
              <ul className="space-y-1">
                {regime.checklist.map((row) => (
                  <li key={row.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    {row.present ? (
                      <Check aria-hidden="true" className="h-3 w-3 shrink-0 text-emerald-700 dark:text-emerald-400" />
                    ) : (
                      <Minus aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                    )}
                    {row.href ? (
                      <a
                        href={row.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="pharos-focus-ring rounded-sm text-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground"
                      >
                        {row.label}
                      </a>
                    ) : (
                      <span className={row.present ? "text-foreground" : "text-muted-foreground"}>{row.label}</span>
                    )}
                    {row.note ? <span className="text-muted-foreground/80">· {row.note}</span> : null}
                    <span className="sr-only">{row.present ? "published" : "not found"}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        <EvidenceFooter
          sources={view.sources}
          trailing={view.reviewedAt ? `Reviewed ${view.reviewedAt}` : undefined}
        />
      </div>
    </RailCard>
  );
}
