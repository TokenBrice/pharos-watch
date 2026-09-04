"use client";

import type { ReactNode } from "react";
import { DEWSRadarPanel } from "@/components/dews-summary";
import { MethodologyLabel } from "@/components/methodology-hint";
import { TIER_META } from "@/components/depeg-resolver-row-card-model";
import type { ResolverBookSummary } from "@/components/depeg-resolver-book-summary";
import { cn } from "@/lib/utils";
import { deviationBorderClass, deviationColorClass } from "@/lib/severity-colors";
import { formatPercent } from "@shared/lib/format";
import { DDR_RESOLUTION_TIER_VALUES } from "@shared/types/depeg-resolver";
import type { DdrrSummary } from "@shared/types/depeg-resolver-review";
import type { PegSummaryStats } from "@shared/types";

interface DepegOutlookHeroProps {
  stats: PegSummaryStats | null | undefined;
  /** Coins in a confirmed live depeg. Drives the radar halos. */
  activeDepegIds: ReadonlySet<string>;
  /** Threshold crossings still awaiting confirmation. */
  pendingCount: number;
  /** DEWS ALERT-or-worse coins, restricted to the peg catalog. */
  dewsAlertCount: number;
  /** Whole-book recovery posture from DDR; omitted when the flag is off. */
  book?: ResolverBookSummary | null;
  /** DDR calibration lineage, shown as the posture's provenance. */
  lineage?: { incidentCount: number; coinCount: number } | null;
  /** DDRR headline accuracy; omitted when the reviewer flag is off. */
  review?: DdrrSummary | null;
  logos?: Record<string, string>;
  /** The DEWS alert queue, composed at the foot of the command rail. */
  alertQueue?: ReactNode;
  /** Conditional reliability caveats, shown as a quiet band under the hero. */
  footer?: ReactNode;
}

function StatCell({ label, value, detail }: { label: ReactNode; value: string; detail: string }) {
  return (
    <div>
      <p className="pharos-kicker">{label}</p>
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
      <p className="pharos-kicker">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * The route's signature hero: a command rail stating the whole current picture —
 * confirmed incidents, early warning, recovery posture and forecast track record
 * — beside the DEWS radar drawn at hero scale.
 *
 * Scope matters here. The One Beam count, worst-live move and holding-peg split
 * come from the live-peg-status subset; the ALERT+ figure is scoped to the peg
 * catalog; the radar plots every DEWS-covered asset. Each figure names its own
 * universe, and this hero is the single owner of all of them — no later module
 * on the route restates them.
 */
export function DepegOutlookHero({
  stats,
  activeDepegIds,
  pendingCount,
  dewsAlertCount,
  book,
  lineage,
  review,
  logos,
  alertQueue,
  footer,
}: DepegOutlookHeroProps) {
  const activeCount = stats?.activeDepegCount ?? 0;
  const worst = stats?.worstCurrent;
  const tiers = book
    ? DDR_RESOLUTION_TIER_VALUES.filter((tier) => book.tierCounts[tier] > 0)
    : [];
  const headline = review?.headline;
  const accuracyPct = headline?.recoveryLikelihoodAccuracyPct ?? null;

  return (
    <section aria-label="Live depeg outlook" className="pharos-card-shell overflow-hidden">
      {/* Static column utilities on purpose: an arbitrary `grid-cols-[minmax(...)]`
          track is a one-off Tailwind class, and a dev server whose CSS predates it
          silently collapses this hero to a single column. */}
      <div className="grid gap-x-8 gap-y-6 p-5 sm:p-6 lg:grid-cols-3">
        <div className="flex flex-col gap-3 lg:col-span-1">
          <div>
            <p className="pharos-kicker">
              <MethodologyLabel topic="activeDepegs">Active depegs</MethodologyLabel>
            </p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="pharos-numeric text-4xl font-semibold leading-none tracking-tight text-frost-blue">
                {stats ? activeCount : "—"}
              </span>
              <span className="text-sm text-muted-foreground">
                {/* "All pegs holding" is a claim about data we have. Without a peg
                    summary the honest reading is that we cannot say. */}
                {!stats
                  ? "peg summary unavailable"
                  : activeCount === 0
                    ? "all pegs holding"
                    : `confirmed ${activeCount === 1 ? "depeg" : "depegs"} right now`}
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
          </div>

          <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 border-t border-border/60 pt-3">
            <StatCell
              label="Pending"
              value={String(pendingCount)}
              detail={pendingCount === 1 ? "crossing" : "crossings"}
            />
            <StatCell label="DEWS alert+" value={String(dewsAlertCount)} detail="of the peg catalog" />
            <StatCell
              label={<MethodologyLabel topic="coinsAtPeg">Holding peg</MethodologyLabel>}
              value={`${stats?.coinsAtPeg ?? 0} / ${stats?.totalTracked ?? 0}`}
              detail="live peg status"
            />
            <StatCell
              label="Median deviation"
              value={`${stats?.medianDeviationBps ?? 0} bps`}
              detail="live peg status"
            />
          </div>

          {book && book.total > 0 ? (
            <RailGroup label="Recovery outlook · DDR">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {tiers.map((tier) => (
                  <span key={tier} className="inline-flex items-baseline gap-1 text-xs">
                    <span className={cn("pharos-numeric text-sm font-semibold", TIER_META[tier].accent)}>
                      {book.tierCounts[tier]}
                    </span>
                    <span className={TIER_META[tier].accent}>{TIER_META[tier].label.toLowerCase()}</span>
                  </span>
                ))}
              </div>
              <p className="pharos-meta mt-1">
                {book.pastPeakCount > 0 ? (
                  <span className="text-amber-700 dark:text-amber-400">
                    {book.pastPeakCount === 1 ? "1 is" : `${book.pastPeakCount} are`} past their worst ·{" "}
                  </span>
                ) : null}
                {lineage
                  ? `calibrated on ${lineage.incidentCount.toLocaleString()} recovered incidents`
                  : `${book.total} open ${book.total === 1 ? "forecast" : "forecasts"}`}
              </p>
            </RailGroup>
          ) : null}

          {headline && headline.recoveryLikelihoodScoredCount > 0 ? (
            <RailGroup label="Forecast track record · DDRR">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="pharos-numeric text-lg font-semibold text-foreground">
                  {accuracyPct != null ? formatPercent(accuracyPct * 100, 1) : "—"}
                </span>
                <span className="text-xs text-muted-foreground">
                  recovery calls correct ({headline.recoveryLikelihoodCorrectCount}/
                  {headline.recoveryLikelihoodScoredCount} graded)
                </span>
              </p>
              <p className="pharos-meta mt-1">
                {review?.headlineLabel ?? headline.accuracyDenominatorLabel} ·{" "}
                <a href="#forecast-grading" className="pharos-prose-link">
                  see the grading
                </a>
              </p>
            </RailGroup>
          ) : null}
          {alertQueue ? <div className="border-t border-border/60 pt-3">{alertQueue}</div> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-2 lg:col-span-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="pharos-section-title">
              <MethodologyLabel topic="dews">DEWS early warning</MethodologyLabel>
            </h2>
            <p className="pharos-meta">every DEWS-covered asset · halo marks an elevated coin in confirmed depeg</p>
          </div>
          <DEWSRadarPanel
            logos={logos}
            activeDepegIds={activeDepegIds}
            maxHeight={520}
            className="flex-1"
          />
        </div>
      </div>
      {footer ? <div className="border-t border-border/60 px-5 py-4 sm:px-6">{footer}</div> : null}
    </section>
  );
}
