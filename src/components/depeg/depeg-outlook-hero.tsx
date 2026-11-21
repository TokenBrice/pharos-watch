"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { DEWSRadarPanel } from "@/components/dews/dews-summary";
import { MethodologyLabel } from "@/components/methodology-hint";
import { describeDdrVerdict } from "@/components/depeg/depeg-resolver-row-card-state";
import { UniverseChip } from "@/components/universe-chip";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import type { OpenIncidentRow } from "@/components/depeg/depeg-resolver-book-summary";
import { cn } from "@/lib/utils";
import { deviationBorderClass, deviationColorClass } from "@/lib/severity-colors";
import { DEPEG_PENDING_STATE_LABELS } from "@shared/lib/classification";
import { formatCompactUsdShort } from "@shared/lib/format";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { PegSummaryStats } from "@shared/types/peg";

interface DepegOutlookHeroProps {
  stats: PegSummaryStats | null | undefined;
  /** Coins with an open confirmed incident. Drives the radar halos. */
  activeDepegIds: ReadonlySet<string>;
  /** Coins in the live peg summary (the peg catalog); null while it is unread. */
  catalogCount?: number | null;
  /** Threshold crossings still awaiting confirmation. */
  pendingCount: number | null;
  /** The confirmed census ranked by holder exposure; null while the peg summary is unread. */
  openIncidents?: readonly OpenIncidentRow[] | null;
  /** DEWS ALERT-or-worse coins, restricted to the peg catalog. */
  dewsAlertCount: number | null;
  /** First reads still needed by each figure or rail group. */
  pendingSources?: { peg: boolean; pegCatalog?: boolean; dews: boolean; radar?: boolean; events: boolean };
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

/** Open incidents named under the headline; the headline counts the whole census. */
const OPEN_INCIDENT_ROWS = 5;

function OpenIncidentList({ rows }: { rows: readonly OpenIncidentRow[] }) {
  const visible = rows.slice(0, OPEN_INCIDENT_ROWS);
  return (
    <div className="border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="pharos-section-title">Open incidents</h3>
        <p className="pharos-meta">
          {rows.length > visible.length ? `Top ${visible.length} of ${rows.length} by holder exposure` : "By holder exposure"}
        </p>
      </div>
      <ul className="mt-1.5">
        {visible.map((row) => {
          // Basis points, like the worst-move chip and the homepage card.
          const deviation = row.referenceNote ?? (row.deviationBps == null
            ? "—"
            : `${row.deviationBps < 0 ? "−" : row.deviationBps > 0 ? "+" : ""}${Math.abs(row.deviationBps).toFixed(0)} bps`);
          const verdict = row.ddr ? describeDdrVerdict(row.ddr, true) : { label: "—", accent: "text-muted-foreground" };
          const cap = row.marketCapUsd == null ? "—" : formatCompactUsdShort(row.marketCapUsd);
          return (
            <li key={row.id}>
              <Link
                prefetch={false}
                href={buildStablecoinUrl(row.id, "#depeg-resolver")}
                aria-label={`${row.symbol}: ${row.referenceNote ?? (row.deviationBps == null ? "deviation unavailable" : deviation)}, DDR ${row.ddr ? verdict.label : "no forecast read"}, market cap ${row.marketCapUsd == null ? "unavailable" : cap}`}
                className="pharos-focus-ring -mx-1 flex min-h-11 items-center gap-x-2 rounded-sm px-1 text-xs hover:bg-muted/50 sm:min-h-8"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{row.symbol}</span>
                <span className="pharos-numeric w-18 shrink-0 text-right text-foreground" title={row.referenceNote ?? undefined}>
                  {deviation}
                </span>
                <span className={cn("max-w-32 shrink-0 truncate", verdict.accent)} title={verdict.label}>
                  {verdict.label}
                </span>
                <span className="pharos-numeric w-14 shrink-0 text-right text-muted-foreground">{cap}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The route's signature hero: a live "Now" command rail (confirmed incidents,
 * worst live move, awaiting confirmations, DEWS alerts, holding peg, median
 * deviation) beside the DEWS radar drawn at hero scale.
 *
 * Scope matters here. The headline count is non-NAV confirmed detections across
 * the peg catalog; worst-live move and holding-peg split come from the
 * live-peg-status subset; the ALERT+ figure is scoped to the peg catalog; the
 * radar plots every DEWS-covered asset. Recovery forecasts (DDR) and track
 * record (DDRR) live in DepegResolverModule below.
 */
export function DepegOutlookHero({
  stats,
  activeDepegIds,
  catalogCount,
  pendingCount,
  openIncidents,
  dewsAlertCount,
  pendingSources,
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
  const signedWorstBps = worst ? `${worst.bps > 0 ? "+" : ""}${worst.bps}` : null;
  const worstHref = worst
    ? buildStablecoinUrl(worst.id, activeDepegIds.has(worst.id) ? "#depeg-resolver" : undefined)
    : null;
  const pegMissing = pendingSources?.peg ? "Loading peg summary…" : "peg summary unavailable";

  return (
    <section id="live-outlook" aria-label="Live depeg outlook" className="pharos-card-shell scroll-mt-24 overflow-hidden">
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
                <span className="pharos-hero-kpi">
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
              {worst && signedWorstBps && worstHref ? (
                <Link
                  prefetch={false}
                  href={worstHref}
                  className={cn(
                    "pharos-focus-ring ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-85 sm:min-h-6 sm:px-2 sm:py-0.5",
                    deviationBorderClass(Math.abs(worst.bps)),
                    deviationColorClass(Math.abs(worst.bps)),
                  )}
                  title={`Worst live move: ${signedWorstBps} bps (${worst.symbol})`}
                  aria-label={`Worst live move: ${signedWorstBps} bps ${worst.symbol}, open coin detail`}
                >
                  <span className="pharos-numeric">{signedWorstBps} bps</span>
                  <span className="opacity-85">{worst.symbol}</span>
                </Link>
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

          {/* The first question is "what is off peg": name the largest incidents
              under the count, before the precursor queue. */}
          {openIncidents?.length || reservedSources?.peg ? (
            <div className={reservedSources?.peg ? "min-h-67 sm:min-h-52" : undefined}>
              {openIncidents?.length ? <OpenIncidentList rows={openIncidents} /> : null}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 border-t border-border/60 pt-3">
            <StatCell
              reserve={reservedSources?.events}
              label={DEPEG_PENDING_STATE_LABELS.crossing}
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
        </div>
        <div id="dews-radar" className="flex min-w-0 scroll-mt-24 flex-col gap-2 lg:col-span-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="pharos-section-title">
              <MethodologyLabel topic="dews">DEWS early warning</MethodologyLabel>
            </h2>
            <p className="pharos-meta">every DEWS-covered asset · halo marks an elevated coin with an open confirmed incident</p>
          </div>
          <DEWSRadarPanel
            logos={logos}
            activeDepegIds={activeDepegIds}
            maxHeight={420}
            reserveSpace={reserveRadar}
            reserveLegend={reserveQueue}
          />
          {/* The precursor queue is the radar's detail layer, so it sits under it and balances
              the rail's depeg column instead of lengthening it. */}
          {queue || reserveQueue ? <div className={cn("border-t border-border/60 pt-3", reserveQueue && "min-h-84 sm:min-h-76")}>{queue}</div> : null}
        </div>
      </div>
      {footer ? <div className="border-t border-border/60 px-5 py-4 sm:px-6">{footer}</div> : null}
    </section>
  );
}
