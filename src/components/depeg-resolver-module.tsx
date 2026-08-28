"use client";

import type { CSSProperties } from "react";
import { DdrInfoTooltip } from "@/components/depeg-resolver-info-tooltip";
import { Badge } from "@/components/ui/badge";
import { DepegResolverRowCard } from "@/components/depeg-resolver-row-card-parts";
import { isDepegResolverEnabled } from "@/lib/feature-flags";
import { DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { DDR_PUBLIC_WARNING, type DdrResponse } from "@shared/types/depeg-resolver";

interface DepegResolverModuleProps {
  data: DdrResponse | undefined;
  logos?: Record<string, string>;
}

// --- module header ---------------------------------------------------------

function ResolverHeader({ data }: { data: DdrResponse | undefined }) {
  const lineage = data?._meta.lineage ?? null;
  const versionLabel = data?.methodology.currentVersionLabel ?? DDR_METHODOLOGY_VERSION_LABEL;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-2.5">
          <span className="rounded-md bg-foreground px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-[0.08em] text-background">
            DDR
          </span>
          <h2 className="pharos-section-title">Depeg Duration Resolver</h2>
          {versionLabel ? (
            <Badge
              variant="outline"
              className="border-border/60 bg-muted/40 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wide text-muted-foreground"
            >
              {versionLabel}
            </Badge>
          ) : null}
          <Badge
            variant="outline"
            className="border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400"
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
          <p className="pharos-numeric text-[10px] text-muted-foreground">
            calibrated on {lineage.incidentCount.toLocaleString()} recovered incidents · {lineage.coinCount} coins
          </p>
        ) : null}
      </div>
      <p className="text-pretty text-sm text-muted-foreground">
        Calls whether a live depeg recovers — and how long it takes —{" "}
        <span className="text-foreground">before the event resolves</span>.{" "}
        <span className="text-muted-foreground/70">{DDR_PUBLIC_WARNING}</span>
      </p>
    </div>
  );
}

// --- public component -------------------------------------------------------

export function DepegResolverModule({ data, logos }: DepegResolverModuleProps) {
  if (!isDepegResolverEnabled()) return null;

  const rows = data?.rows ?? [];
  const showStaleRows = data?._meta.degraded === true && data._meta.degradedReason === "stale-cache" && rows.length > 0;

  return (
    <section aria-label="Depeg Duration Resolver" className="space-y-4">
      <ResolverHeader data={data} />

      {!data ? (
        <div className="pharos-empty-note text-center">Resolver data is loading.</div>
      ) : data._meta.degraded && !showStaleRows ? (
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
          {showStaleRows ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              Resolver snapshot is stale; duration estimates are suppressed until the next refresh.
            </p>
          ) : null}
          <div className="pharos-stagger-entrance grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            {rows.map((row, i) => (
              <div key={`${row.stablecoinId}:${row.eventId}`} style={{ "--stagger-index": i } as CSSProperties}>
                <DepegResolverRowCard row={row} logos={logos} />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
