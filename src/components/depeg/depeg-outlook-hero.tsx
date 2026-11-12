"use client";

import { useState, type ReactNode } from "react";
import { DEWSRadarPanel } from "@/components/dews/dews-summary";
import { HERO_KPI_VALUE_CLASS } from "@/components/feature-hero-split";
import { MethodologyLabel } from "@/components/methodology-hint";
import { getTierMeta } from "@/components/depeg/depeg-resolver-row-card-model";
import { UniverseChip } from "@/components/universe-chip";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import type { ResolverBookSummary } from "@/components/depeg/depeg-resolver-book-summary";
import { cn } from "@/lib/utils";
import { describePromotedAccuracy, formatPromotedAccuracyLines } from "@/lib/ddr-promoted-accuracy";
import { deviationBorderClass, deviationColorClass } from "@/lib/severity-colors";
import { formatPercent } from "@shared/lib/format";
import type { DdrrSummary } from "@shared/types/depeg-resolver-review";
import type { PegSummaryStats } from "@shared/types/peg";

interface DepegOutlookHeroProps {
  stats: PegSummaryStats | null | undefined;
  /** Coins with an open confirmed incident. Drives the radar halos. */
  activeDepegIds: ReadonlySet<string>;
  /** Coins in the live peg summary (the peg catalog); null while it is unread. */
  catalogCount?: number | null;
  /** Threshold crossings still awaiting confirmation. */
  pendingCount: number | null;
  /** DEWS ALERT-or-worse coins, restricted to the peg catalog. */
  dewsAlertCount: number | null;
  /** First reads still needed by each figure or rail group. */
  pendingSources?: { peg: boolean; pegCatalog?: boolean; dews: boolean; radar?: boolean; events: boolean; resolver: boolean; review: boolean };
  /** Whole-book recovery posture from DDR; omitted when the flag is off. */
  book?: ResolverBookSummary | null;
  /** DDR calibration lineage, shown as the posture's provenance. */
  lineage?: { incidentCount: number; coinCount: number } | null;
  /** DDRR headline accuracy; omitted when the reviewer flag is off. */
  review?: DdrrSummary | null;
  logos?: Record<string, string>;
  /** Compose the queue with the first-show reservation decision. */
  alertQueue?: (reserveSpace: boolean) => ReactNode;
  /** Conditional reliability caveats, shown as a quiet band under the hero. */
  footer?: ReactNode;
}

function StatCell({ label, value, detail, reserve }: { label: ReactNode; value: string; detail: string; reserve?: boolean }) {
  return (
    <div className={reserve ? "min-h-20" : undefined}>
      <p className="pharos-label">{label}</p>
      <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
        <span className="pharos-numeric text-lg font-semibold leading-tight text-foreground">{value}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </p>
    </div>
  );
}

function RailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-border/60 pt-3">
      <p className="pharos-label">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * The route's signature hero: a command rail stating the whole current picture —
 * confirmed incidents, early warning, recovery posture and forecast track record
 * — beside the DEWS radar drawn at hero scale.
 *
 * Scope matters here. The headline count is non-NAV confirmed detections across
 * the peg catalog; worst-live move and holding-peg split come from the
 * live-peg-status subset; the ALERT+ figure is scoped to the peg catalog; the
 * radar plots every DEWS-covered asset. Each figure names its own
 * universe, and this hero is the single owner of all of them — no later module
 * on the route restates them.
 */
export function DepegOutlookHero({
  stats,
  activeDepegIds,
  catalogCount,
  pendingCount,
  dewsAlertCount,
  pendingSources,
  book,
  lineage,
  review,
  logos,
  alertQueue,
  footer,
}: DepegOutlookHeroProps) {
  // This component mounts at first show; later results cannot enroll or remove a reservation.
  const [reservedSources] = useState(() => ({ ...pendingSources }));
  const reserveRadar = reservedSources?.radar ?? reservedSources?.dews ?? false;
  const reserveQueue = reserveRadar || !!reservedSources?.peg;
  const queue = alertQueue?.(reserveQueue);
  const activeCount = stats?.activeDepegCount ?? 0;
  const worst = stats?.worstCurrent;
  const tierGroups = book?.tierGroups ?? [];
  const headline = review?.headline;
  const accuracyPct = headline?.recoveryLikelihoodAccuracyPct ?? null;
  const accuracyLines = review ? formatPromotedAccuracyLines(describePromotedAccuracy(review)) : null;
  const pegMissing = pendingSources?.peg ? "Loading peg summary…" : "peg summary unavailable";

  return (
    <section aria-label="Live depeg outlook" className="pharos-card-shell overflow-hidden">
      {/* Static column utilities on purpose: an arbitrary `grid-cols-[minmax(...)]`
          track is a one-off Tailwind class, and a dev server whose CSS predates it
          silently collapses this hero to a single column. */}
      <div className="grid gap-x-8 gap-y-6 p-5 sm:p-6 lg:grid-cols-3">
        <div className="flex flex-col gap-3 lg:col-span-1">
          <div className={reservedSources?.peg ? "min-h-32 lg:min-h-36" : undefined}>
            <p className="pharos-label">
              <MethodologyLabel topic="activeDepegs">Active depegs</MethodologyLabel>
            </p>
            <div className={cn("mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1", reservedSources?.peg && "min-h-16 content-start lg:min-h-20")}>
              <RailHeroFigureTransition rail="depeg">
                <span className={HERO_KPI_VALUE_CLASS}>
                  {stats ? activeCount : "—"}
                </span>
              </RailHeroFigureTransition>
              <span className="text-sm text-muted-foreground">
                {/* An open lifecycle record, not a claim that the coin is off peg
                    now: recovery may be observed but not yet confirmed. Without a
                    peg summary the honest reading is that we cannot say. */}
                {!stats
                  ? pegMissing
                  : activeCount === 1
                    ? "coin with an open confirmed incident"
                    : "coins with open confirmed incidents"}
              </span>
              {worst ? (
                <span
                  className={cn(
                    "ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
                    deviationBorderClass(Math.abs(worst.bps)),
                    deviationColorClass(Math.abs(worst.bps)),
                  )}
                  title="Worst live move"
                >
                  <span className="pharos-numeric">{Math.abs(worst.bps)} bps</span>
                  <span className="opacity-80">{worst.symbol}</span>
                </span>
              ) : null}
            </div>
            {/* The headline counts the peg catalog minus NAV tokens; the chip names
                the catalog's size as read this render. */}
            <UniverseChip
              universe="pegCatalog"
              value={catalogCount == null ? undefined : `${catalogCount.toLocaleString()} coins`}
              className="mt-2"
            />
          </div>

          <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 border-t border-border/60 pt-3">
            <StatCell
              reserve={reservedSources?.events}
              label="Pending"
              value={pendingCount == null ? "—" : String(pendingCount)}
              detail={pendingCount == null ? pendingSources?.events ? "Loading event data…" : "event data unavailable" : pendingCount === 1 ? "crossing" : "crossings"}
            />
            <StatCell reserve={reservedSources?.dews || reservedSources?.pegCatalog} label="DEWS alert+" value={dewsAlertCount == null ? "—" : String(dewsAlertCount)} detail={dewsAlertCount == null ? pendingSources?.dews ? "Loading DEWS…" : pendingSources?.pegCatalog ? "Loading peg catalog…" : "DEWS or peg catalog unavailable" : "of the peg catalog"} />
            <StatCell
              reserve={reservedSources?.peg}
              label={<MethodologyLabel topic="coinsAtPeg">Holding peg</MethodologyLabel>}
              value={stats ? `${stats.coinsAtPeg} / ${stats.totalTracked}` : "—"}
              detail={stats ? "live peg status" : pegMissing}
            />
            <StatCell
              reserve={reservedSources?.peg}
              label="Median deviation"
              value={stats?.medianDeviationBps == null ? "—" : `${stats.medianDeviationBps} bps`}
              detail={!stats ? pegMissing : stats.medianDeviationBps === null ? "live peg status unavailable" : "live peg status"}
            />
          </div>

          {reservedSources?.resolver || (book && book.total > 0) || pendingSources?.resolver ? (
            <div className={reservedSources?.resolver ? "min-h-32" : undefined}>
              {book && book.total > 0 ? (
                <RailGroup label="Recovery outlook · DDR">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {tierGroups.map(({ tier, vocabulary, count }) => {
                      const meta = getTierMeta(tier, vocabulary);
                      return (
                        <span key={`${tier}:${vocabulary}`} className="inline-flex items-baseline gap-1 text-xs">
                          <span className={cn("pharos-numeric text-sm font-semibold", meta.accent)}>{count}</span>
                          <span className={meta.accent}>{meta.label.toLowerCase()}</span>
                        </span>
                      );
                    })}
                  </div>
                  <p className="pharos-meta mt-1">
                    {book.pastPeakCount > 0 ? (
                      <span className="text-state-warn">
                        {book.pastPeakCount} at a new worst ·{" "}
                      </span>
                    ) : null}
                    {lineage
                      ? `calibrated on ${lineage.incidentCount.toLocaleString()} historical incidents`
                      : `${book.total} open ${book.total === 1 ? "forecast" : "forecasts"}`}
                  </p>
                </RailGroup>
              ) : pendingSources?.resolver ? (
                <RailGroup label="Recovery outlook · DDR">
                  <p className="pharos-meta">Loading DDR…</p>
                </RailGroup>
              ) : null}
            </div>
          ) : null}

          {reservedSources?.review || (headline && headline.recoveryLikelihoodScoredCount > 0) || pendingSources?.review ? (
            <div className={reservedSources?.review ? "min-h-28" : undefined}>
              {headline && accuracyLines && headline.recoveryLikelihoodScoredCount > 0 ? (
                <RailGroup label="Forecast track record · DDRR">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="pharos-numeric text-lg font-semibold text-foreground">
                      {accuracyPct != null ? formatPercent(accuracyPct * 100, 1) : "—"}
                    </span>
                    <span className="text-xs text-muted-foreground">{accuracyLines.calls}</span>
                  </p>
                  <p className="pharos-meta mt-1">
                    {review?.headlineLabel ?? headline.accuracyDenominatorLabel} ·{" "}
                    <a href="#forecast-grading" className="pharos-prose-link">
                      see the grading
                    </a>
                  </p>
                </RailGroup>
              ) : pendingSources?.review ? (
                <RailGroup label="Forecast track record · DDRR">
                  <p className="pharos-meta">Loading DDRR…</p>
                </RailGroup>
              ) : null}
            </div>
          ) : null}
          {queue || reserveQueue ? <div className={cn("border-t border-border/60 pt-3", reserveQueue && "min-h-84 sm:min-h-76")}>{queue}</div> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-2 lg:col-span-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="pharos-section-title">
              <MethodologyLabel topic="dews">DEWS early warning</MethodologyLabel>
            </h2>
            <p className="pharos-meta">every DEWS-covered asset · halo marks an elevated coin with an open confirmed incident</p>
          </div>
          <DEWSRadarPanel
            logos={logos}
            activeDepegIds={activeDepegIds}
            maxHeight={520}
            reserveSpace={reserveRadar}
            reserveLegend={reserveQueue}
            className="flex-1"
          />
        </div>
      </div>
      {footer ? <div className="border-t border-border/60 px-5 py-4 sm:px-6">{footer}</div> : null}
    </section>
  );
}
