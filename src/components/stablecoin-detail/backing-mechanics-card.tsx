"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MechanismBackingMetric, MechanismBackingNote, MechanismBackingView } from "@/lib/mechanism-backing";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";

const STATE_LABELS: Record<MechanismBackingNote["state"], string> = {
  "not-applicable": "Not applicable",
  unavailable: "Not disclosed",
};

const STATE_BADGE_CLASSES: Record<MechanismBackingNote["state"], string> = {
  "not-applicable": "border-border/60 bg-muted/40 text-muted-foreground",
  unavailable: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

function formatMetric(metric: MechanismBackingMetric): string {
  if (metric.unit === "days") {
    if (metric.value === 0) return "Continuous";
    if (metric.value < 1) return `${(metric.value * 24).toFixed(1)}h`;
    if (metric.value >= 365) return `${(metric.value / 365).toFixed(1)}y`;
    return `${metric.value < 10 ? metric.value.toFixed(1) : Math.round(metric.value).toLocaleString("en-US")}d`;
  }
  if (metric.value >= 1000) return `${Math.round(metric.value).toLocaleString("en-US")}%`;
  return `${metric.value < 1 ? metric.value.toFixed(2) : metric.value.toFixed(1)}%`;
}

function NoteRow({ note, open }: { note: MechanismBackingNote; open: boolean }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 text-xs font-medium text-muted-foreground">{note.label}</p>
        <Badge
          variant="outline"
          className={cn(
            "h-5 shrink-0 rounded-full px-2 text-[10px] font-medium",
            STATE_BADGE_CLASSES[note.state],
          )}
        >
          {STATE_LABELS[note.state]}
        </Badge>
      </div>
      {open ? (
        <>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{note.rationale}</p>
          {note.sourceUrl ? (
            <a
              href={note.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring mt-1 inline-flex items-center gap-1 rounded-sm text-[11px] text-frost-blue underline-offset-2 hover:underline"
            >
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
              Source
            </a>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

/**
 * Right-rail backing module for the archetypes the CDP collateral card does not
 * serve — delta-neutral, RWA credit funds, and algorithmic designs all carry
 * reviewed quantitative metrics that had no home on the page.
 *
 * It also carries the reviewed gaps for any archetype: dimensions ruled
 * structurally not applicable, or measurable in principle but undisclosed by the
 * issuer. Those render with the reviewer's rationale and citation rather than
 * being silently dropped, which is why a CDP asset can show this card with no
 * metrics of its own beneath `CollateralizationCard`.
 */
export function BackingMechanicsCard({ view }: { view: MechanismBackingView | null }) {
  const [open, setOpen] = useState(false);
  if (view === null) return null;

  const [headline, ...rest] = view.metrics;

  return (
    <section className="pharos-card-shell overflow-hidden" aria-label="Backing mechanics">
      <div className="flex items-center justify-between gap-3 px-4 py-3.5">
        <h2 className={DETAIL_MODULE_TITLE_CLASS}>Backing mechanics</h2>
        <span className="inline-flex h-6 items-center rounded-full bg-muted/70 px-2 font-mono text-xs font-medium text-muted-foreground">
          Reviewed {view.reviewedAt}
        </span>
      </div>

      {headline ? (
        <div className="px-4 pb-4">
          <p className="font-mono text-[2rem] font-semibold leading-none tracking-normal tabular-nums text-foreground">
            {formatMetric(headline)}
          </p>
          <p className="mt-2 text-sm font-medium text-muted-foreground">{headline.label}</p>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{headline.hint}</p>
        </div>
      ) : null}

      {rest.length > 0 ? (
        <div className="border-t border-border/50 px-4 py-4">
          <ul className="space-y-3">
            {rest.map((metric) => (
              <li key={metric.key}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-muted-foreground">{metric.label}</p>
                  <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
                    {formatMetric(metric)}
                  </p>
                </div>
                <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{metric.hint}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.protocolFacts.length > 0 ? (
        <div className="border-t border-border/50 px-4 py-4">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Measured from the protocol
          </h3>
          <dl className="mt-2 space-y-1.5">
            {view.protocolFacts.map((fact) => (
              <div key={fact.key} className="flex items-baseline justify-between gap-3">
                <dt className="min-w-0 text-xs text-muted-foreground">{fact.label}</dt>
                <dd className="shrink-0 font-mono text-xs tabular-nums text-foreground">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {view.notes.length > 0 ? (
        <div className="border-t border-border/50 px-4 py-4">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Reviewed gaps ({view.notes.length})
          </h3>
          <ul className="mt-2 space-y-2.5">
            {view.notes.map((note) => <NoteRow key={note.key} note={note} open={open} />)}
          </ul>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="pharos-focus-ring mt-2 inline-flex min-h-7 items-center gap-1 rounded-sm text-[11px] font-medium text-frost-blue"
          >
            {open ? "Show less" : "Why"}
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="border-t border-border/50 px-4 py-3">
        <a
          href={view.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="pharos-focus-ring rounded-sm text-[11px] text-frost-blue underline-offset-2 hover:underline"
        >
          {view.sourceLabel}
        </a>
      </div>
    </section>
  );
}
