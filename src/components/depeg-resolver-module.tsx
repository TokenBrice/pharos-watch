"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { DdrInfoTooltip } from "@/components/depeg-resolver-info-tooltip";
import { Badge } from "@/components/ui/badge";
import { DepegResolverRowCard } from "@/components/depeg-resolver-row-card-parts";
import {
  compareResolverUrgency,
  isResolverBookAvailable,
  summarizeResolverBook,
} from "@/components/depeg-resolver-book-summary";
import { isDepegResolverEnabled } from "@/lib/feature-flags";
import { DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { DDR_PUBLIC_WARNING, type DdrResponse } from "@shared/types/depeg-resolver";

interface DepegResolverModuleProps {
  data: DdrResponse | undefined;
  logos?: Record<string, string>;
}

/**
 * Forecast cards rendered before the disclosure. The worklist answers "what
 * needs attention now"; the full book is one click away and only mounts then.
 */
const DEFAULT_VISIBLE_ROWS = 4;

// --- module header ---------------------------------------------------------

function ResolverHeader({ data, summary }: { data: DdrResponse | undefined; summary: ReactNode }) {
  const lineage = data?._meta.lineage ?? null;
  const versionLabel = data?.methodology.currentVersionLabel ?? DDR_METHODOLOGY_VERSION_LABEL;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-2.5">
          <span className="rounded-md bg-foreground px-1.5 py-0.5 font-mono text-2xs font-bold text-background">
            DDR
          </span>
          <h2 className="pharos-section-title">Depeg Duration Resolver</h2>
          {versionLabel ? (
            <Badge
              variant="outline"
              className="border-border/60 bg-muted/40 px-1.5 py-0 text-3xs font-mono uppercase text-muted-foreground"
            >
              {versionLabel}
            </Badge>
          ) : null}
          <Badge
            variant="outline"
            className="border-state-warn bg-state-warn-subtle px-1.5 py-0 text-3xs uppercase text-state-warn"
          >
            Beta
          </Badge>
          <DdrInfoTooltip
            ariaLabel="About the Depeg Duration Resolver"
            content={
              <>
                For each open confirmed depeg, the resolver weighs kill signals against recovery anchors for a
                mechanistic verdict, then — when recovery is plausible — an empirical expected duration from comparable
                historical incidents.
              </>
            }
          />
        </div>
        {lineage ? (
          <p className="text-2xs text-muted-foreground">
            Calibrated on <span className="pharos-numeric">{lineage.incidentCount.toLocaleString()}</span> historical
            incidents · <span className="pharos-numeric">{lineage.coinCount}</span> coins
            {lineage.quarantinedCoins > 0 ? (
              <>
                {" ("}
                <span className="pharos-numeric">{lineage.quarantinedCoins}</span> excluded)
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      <p className="text-pretty text-sm text-muted-foreground">
        Calls whether a live depeg recovers — and how long it takes —{" "}
        <span className="text-foreground">before the event resolves</span>.{" "}
        <span className="text-muted-foreground/70">{DDR_PUBLIC_WARNING}</span>
      </p>
      {summary}
    </div>
  );
}

// --- public component -------------------------------------------------------

export function DepegResolverModule({ data, logos }: DepegResolverModuleProps) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const ordered = useMemo(() => [...rows].sort(compareResolverUrgency), [rows]);
  const book = useMemo(() => summarizeResolverBook(rows), [rows]);

  if (!isDepegResolverEnabled()) return null;

  const bookAvailable = isResolverBookAvailable(data);
  const visible = showAll ? ordered : ordered.slice(0, DEFAULT_VISIBLE_ROWS);
  const hiddenCount = ordered.length - visible.length;

  // The recovery-verdict split lives in the hero, which owns route-level
  // posture. This header only states the book size and which slice is on
  // screen, so the four cards are never mistaken for the whole book.
  const summary =
    bookAvailable && rows.length > 0 ? (
      <p className="pharos-meta">
        Whole book · <span className="pharos-numeric text-foreground">{book.total}</span>{" "}
        {book.total === 1 ? "forecast" : "forecasts"} across {book.rowCount} incident rows ·{" "}
        {hiddenCount > 0 ? `showing the ${visible.length} most urgent` : `showing all ${visible.length}`}
        {book.pastPeakCount > 0 ? (
          <span className="text-state-warn">
            {" "}
            · {book.pastPeakCount} at a new worst
          </span>
        ) : null}
      </p>
    ) : null;

  return (
    <section aria-label="Depeg Duration Resolver" className="space-y-4">
      <ResolverHeader data={data} summary={summary} />

      {!data ? (
        <div className="pharos-empty-note text-center">Resolver data is loading.</div>
      ) : !bookAvailable ? (
        <div className="pharos-empty-note text-center">Resolver data is temporarily unavailable.</div>
      ) : rows.length === 0 ? (
        <div className="pharos-empty-note">
          <p className="font-medium text-foreground">No active confirmed depegs.</p>
          <p className="mt-1">
            When Pharos confirms an open depeg, its recovery verdict and — if recovery looks likely — an
            expected-duration band appear here.
          </p>
        </div>
      ) : (
        <>
          <div className="pharos-stagger-entrance grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            {visible.map((row, i) => (
              <div key={`${row.stablecoinId}:${row.eventId}`} style={{ "--stagger-index": i } as CSSProperties}>
                <DepegResolverRowCard row={row} logos={logos} />
              </div>
            ))}
          </div>
          {hiddenCount > 0 || showAll ? (
            <button
              type="button"
              onClick={() => setShowAll((open) => !open)}
              aria-expanded={showAll}
              className="pharos-focus-ring pharos-control-pill"
            >
              {showAll ? `Show only the ${DEFAULT_VISIBLE_ROWS} most urgent` : `Show all ${ordered.length} incident rows`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
