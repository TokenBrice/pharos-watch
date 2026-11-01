"use client";

import Link from "next/link";
import { useMemo } from "react";

import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { HomeAltTrackerLink } from "@/components/home-alt-tracker-link";
import { Skeleton } from "@/components/ui/skeleton";
import { YieldSafetyBadge } from "@/components/yield-leaderboard-row-parts";
import { UniverseChip } from "@/components/universe-chip";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import { isOpportunityDerivedSafety } from "@shared/lib/yield-opportunity-provenance";
import { useYieldRankingsSummary } from "@/hooks/api-hooks";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatPercent, formatScore } from "@shared/lib/format";
import { dedupeYieldRankings } from "@shared/lib/yield-rankings";
import { buildYieldStoryCallouts } from "@/lib/yield-story-callouts";
import {
  YIELD_LANDING_RISK_BUDGET,
  YIELD_RISK_BUDGET_SPECS,
  prepareYieldUniverse,
  selectTopPysRows,
  selectVisibleYieldRows,
  type YieldViewModelRow,
} from "@/lib/yield-view-model";
import type { YieldRankingSummary } from "@shared/types/yield-summary";
import type { YieldSafetySnapshotMeta } from "@shared/types/yield";

// The /yield/ page opens on this risk band; the home card answers for the same view.
const LANDING_BAND_LABEL =
  YIELD_RISK_BUDGET_SPECS.find((spec) => spec.key === YIELD_LANDING_RISK_BUDGET)?.label ?? YIELD_LANDING_RISK_BUDGET;

const LEADERBOARD_SIZE = 5;

// Shared 5-column grid so the (separate) header row and each leaderboard row
// align: rank · coin · (PYS bar) · PYS · APY · grade. The PYS figure sits at the
// end of the bar it labels so the bar is never read against APY. Fixed metric
// widths keep the columns flush across the independent grid containers.
const ROW_GRID = "grid grid-cols-[1.5rem_minmax(0,1fr)_3.5rem_4.5rem_2.75rem] items-center sm:grid-cols-[1.5rem_7rem_minmax(0,1fr)_3.5rem_4.5rem_2.75rem] gap-x-2";

interface OverviewData {
  /** `null` when the payload carries no safety-snapshot coverage: "unknown", never "N/N". */
  coveredCount: number | null;
  trackedCount: number | null;
  medianApy: number | null;
  /** Rows in the /yield/ landing view (its default risk band) and in the whole universe. */
  inViewCount: number;
  totalRowCount: number;
  /** The page's "Highest APY" in the same landing view. */
  highestApy: YieldViewModelRow | null;
  /** The page hero: best-paid risk in view, by Pharos Yield Score. */
  bestPaid: YieldViewModelRow | null;
  leaders: YieldViewModelRow[];
}

/**
 * Same derivation as the /yield/ hero with no URL filters: dedupe, prepare the
 * universe, select the landing band's visible rows, then rank by PYS.
 */
function buildOverview(
  rankings: YieldRankingSummary[],
  snapshot: YieldSafetySnapshotMeta | null,
): Omit<OverviewData, "medianApy"> {
  const universe = prepareYieldUniverse(dedupeYieldRankings(rankings), null);
  const visibleRows = selectVisibleYieldRows(universe, {});
  const leaders = selectTopPysRows(visibleRows, LEADERBOARD_SIZE);

  return {
    // A degraded payload has no safety snapshot at all; falling back to
    // `rankings.length` reported "157/157 covered" exactly when nothing was.
    coveredCount: snapshot?.coveredCount ?? null,
    trackedCount: snapshot?.trackedCount ?? null,
    inViewCount: visibleRows.length,
    totalRowCount: universe.rowFacets.length,
    highestApy: buildYieldStoryCallouts(visibleRows)?.topYield ?? null,
    bestPaid: leaders[0] ?? null,
    leaders,
  };
}

function OverviewHeader({ coveredCount }: { coveredCount: number | null }): React.JSX.Element {
  return (
    <div className="space-y-1 sm:space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <p className="font-display text-2xl font-bold text-foreground sm:text-3xl">Yield Intelligence</p>
        <div className="flex shrink-0 items-center gap-3 sm:pt-0">
          {coveredCount !== null && (
            <>
              <span className="hidden text-sm text-muted-foreground sm:inline">
                <span className="pharos-numeric font-semibold text-foreground">{coveredCount}</span> covered
              </span>
              <span aria-hidden="true" className="hidden h-1 w-1 rounded-full bg-border sm:inline-block" />
            </>
          )}
          <HomeAltTrackerLink
            href="/yield/"
            prefetch={false}
            ariaLabel="Open yield tracker"
          />
        </div>
      </div>
      <p className="text-3xs leading-snug text-muted-foreground sm:text-sm">
        Risk-adjusted stablecoin yield, scored by the Pharos Yield Score.
      </p>
    </div>
  );
}

function LeadFigure({
  bestPaid,
  inViewCount,
  totalRowCount,
}: {
  bestPaid: YieldViewModelRow | null;
  inViewCount: number;
  totalRowCount: number;
}): React.JSX.Element {
  return (
    <div className="space-y-2 pb-3">
      <p className="text-sm font-medium text-muted-foreground">
        Best-paid risk in view
        {bestPaid ? <span className="text-foreground/70"> · {bestPaid.symbol}</span> : null}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <RailHeroFigureTransition rail="yield">
          <span className="pharos-numeric text-4xl font-bold tracking-tight text-foreground">
            {bestPaid ? formatPercent(bestPaid.apy30d) : "—"}
          </span>
        </RailHeroFigureTransition>
        {bestPaid ? (
          <span className="pharos-numeric text-xs text-muted-foreground">PYS {formatScore(bestPaid.pharosYieldScore)}</span>
        ) : null}
        <UniverseChip
          universe="yieldRows"
          value={`${inViewCount} in view of ${totalRowCount} · ${LANDING_BAND_LABEL}`}
          className="sm:ml-auto"
        />
      </div>
    </div>
  );
}

function StatStrip({
  coveredCount,
  trackedCount,
  medianApy,
  highestApy,
}: {
  coveredCount: number | null;
  trackedCount: number | null;
  medianApy: number | null;
  highestApy: YieldViewModelRow | null;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 divide-x divide-border/50 border-t border-border/50">
      <div className="flex flex-col gap-1 px-3 py-3 first:pl-0">
        <span className="pharos-label">Coverage</span>
        <span className="pharos-numeric text-lg font-semibold text-foreground sm:text-xl">
          {coveredCount === null || trackedCount === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <>
              {coveredCount}
              <span className="text-sm text-muted-foreground/60">/{trackedCount}</span>
            </>
          )}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3 py-3">
        <span className="pharos-label">TVL-weighted median APY</span>
        <span className="pharos-numeric text-lg font-semibold text-foreground sm:text-xl">
          {medianApy === null ? <span className="text-muted-foreground">—</span> : formatPercent(medianApy)}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3 py-3">
        <span className="pharos-label">Highest APY in view</span>
        {highestApy ? (
          <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 truncate">
            <span className="truncate pharos-numeric text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {highestApy.symbol}
            </span>
            <span className="pharos-numeric shrink-0 text-lg font-semibold text-foreground sm:text-xl">
              {formatPercent(highestApy.apy30d)}
            </span>
          </span>
        ) : (
          <span className="pharos-numeric text-lg font-semibold text-muted-foreground">—</span>
        )}
      </div>
    </div>
  );
}

function LeaderRow({
  row,
  rank,
  logoSrc,
}: {
  row: YieldViewModelRow;
  rank: number;
  logoSrc: string | undefined;
}): React.JSX.Element {
  return (
    <li>
      <Link
        prefetch={false}
        href={buildStablecoinUrl(row.id)}
        className={`pharos-focus-ring -mx-1 rounded-sm px-1 py-1.5 transition-colors hover:bg-muted/50 ${ROW_GRID}`}
      >
        <span className="pharos-numeric text-xs text-muted-foreground">{rank}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <CoinCell logoSrc={logoSrc} />
          <span className="truncate font-mono text-xs tracking-tight text-foreground">{row.symbol}</span>
        </span>
        <span aria-hidden="true" className="hidden h-1.5 overflow-hidden rounded-full bg-muted/60 sm:block">
          {row.pharosYieldScore === null ? null : (
            <span
              className="block h-full rounded-full bg-[var(--chart-primary)]/70"
              style={{ width: `${Math.max(0, Math.min(100, row.pharosYieldScore))}%` }}
            />
          )}
        </span>
        <span className="pharos-numeric justify-self-end text-xs text-muted-foreground">
          {formatScore(row.pharosYieldScore)}
        </span>
        <span className="pharos-numeric justify-self-end text-xs font-semibold text-foreground">
          {formatPercent(row.apy30d)}
        </span>
        <span className="justify-self-end">
          <YieldSafetyBadge
            grade={row.safetyGrade}
            safetyScore={row.safetyScore}
            safetySrLabel={`Yield safety ${row.safetyGrade ?? "unrated"}${row.provenance?.usedDefaultSafety ? " (default safety)" : ""}`}
            opportunityDerived={isOpportunityDerivedSafety(row.provenance?.safetyProvenance)}
            compact
          />
        </span>
      </Link>
    </li>
  );
}

export function HomeAltYieldOverview(): React.JSX.Element | null {
  const { data, isLoading } = useYieldRankingsSummary();
  const logos = logosById;
  const logoMap = logos ?? {};

  const overview = useMemo<OverviewData | null>(() => {
    if (!data) return null;
    const built = buildOverview(data.rankings, data.provenance?.safetySnapshot ?? null);
    return { ...built, medianApy: data.medianApy };
  }, [data]);
  if (isLoading) return <HomeAltYieldOverviewFallback />;

  if (!overview || overview.leaders.length === 0) {
    return (
      <section aria-labelledby="yield-overview-title" className="space-y-3 sm:space-y-4">
        <h2 id="yield-overview-title" className="sr-only">
          Yield Intelligence overview
        </h2>
        <OverviewHeader coveredCount={null} />
        <div className="pharos-card-shell flex items-center justify-center p-6">
          <span className="font-mono text-sm text-muted-foreground">Updating</span>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="yield-overview-title" className="space-y-3 sm:space-y-4">
      <h2 id="yield-overview-title" className="sr-only">
        Yield Intelligence overview
      </h2>

      <OverviewHeader coveredCount={overview.coveredCount} />

      <div className="pharos-card-shell overflow-hidden p-4">
        <LeadFigure
          bestPaid={overview.bestPaid}
          inViewCount={overview.inViewCount}
          totalRowCount={overview.totalRowCount}
        />
        <StatStrip
          coveredCount={overview.coveredCount}
          trackedCount={overview.trackedCount}
          medianApy={overview.medianApy}
          highestApy={overview.highestApy}
        />

        <div className="mt-3 border-t border-border/50 pt-3">
          <div
            className={`${ROW_GRID} pharos-label px-1 pb-1.5`}
          >
            <span aria-hidden="true" />
            <span>Top by PYS in view</span>
            <span aria-hidden="true" className="hidden sm:block" />
            <span className="justify-self-end">PYS</span>
            <span className="justify-self-end">APY</span>
            <span className="justify-self-end">Grade</span>
          </div>
          <ul className="flex flex-col">
            {overview.leaders.map((row, index) => (
              <LeaderRow key={row.id} row={row} rank={index + 1} logoSrc={getLogoSrc(logoMap, row.id)} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export function HomeAltYieldOverviewFallback(): React.JSX.Element {
  return (
    <section aria-labelledby="yield-overview-title" className="space-y-3 sm:space-y-4">
      <h2 id="yield-overview-title" className="sr-only">
        Yield Intelligence overview
      </h2>
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-7 w-24" />
      </div>
      <div className="pharos-card-shell overflow-hidden p-4">
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
        <div className="mt-3 flex flex-col gap-2 border-t border-border/50 pt-3">
          {Array.from({ length: LEADERBOARD_SIZE }).map((_, index) => (
            <Skeleton key={index} className="h-6 w-full" />
          ))}
        </div>
      </div>
    </section>
  );
}
