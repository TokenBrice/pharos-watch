"use client";

import Link from "next/link";
import { useMemo } from "react";

import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { HomeAltTrackerLink } from "@/components/home-alt-tracker-link";
import { Skeleton } from "@/components/ui/skeleton";
import { useYieldRankings } from "@/hooks/api-hooks";
import { logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatPercent, formatScore } from "@shared/lib/format";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/classification";
import type { ReportCardGrade, YieldRanking } from "@shared/types";

const LEADERBOARD_SIZE = 5;

// Shared 5-column grid so the (separate) header row and each leaderboard row
// align: rank · coin · APY · PYS · grade. Fixed metric widths keep the columns
// flush across the independent grid containers.
const ROW_GRID = "grid grid-cols-[1.5rem_minmax(0,1fr)_4.5rem_3.5rem_2.75rem] items-center gap-x-2";

function gradeChipClass(grade: ReportCardGrade): string {
  return REPORT_CARD_GRADE_COLORS[grade];
}

interface OverviewData {
  coveredCount: number;
  trackedCount: number;
  medianApy: number;
  highestRawYield: { symbol: string; apy: number } | null;
  bestRiskAdjusted: YieldRanking | null;
  leaders: YieldRanking[];
}

function buildOverview(
  rankings: readonly YieldRanking[],
  snapshot: { coveredCount: number; trackedCount: number } | null,
): OverviewData {
  const highestRawYield = rankings.reduce<{ symbol: string; apy: number } | null>((best, row) => {
    if (!Number.isFinite(row.apy30d)) return best;
    return best === null || row.apy30d > best.apy ? { symbol: row.symbol, apy: row.apy30d } : best;
  }, null);

  const leaders = rankings
    .filter((row) => row.pharosYieldScore !== null)
    .sort((a, b) => (b.pharosYieldScore ?? 0) - (a.pharosYieldScore ?? 0))
    .slice(0, LEADERBOARD_SIZE);

  return {
    coveredCount: snapshot?.coveredCount ?? rankings.length,
    trackedCount: snapshot?.trackedCount ?? rankings.length,
    medianApy: 0,
    highestRawYield,
    bestRiskAdjusted: leaders[0] ?? null,
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
      <p className="text-[10px] leading-snug text-muted-foreground sm:text-sm">
        Risk-adjusted stablecoin yield, scored by the Pharos Yield Score.
      </p>
    </div>
  );
}

function StatStrip({
  coveredCount,
  trackedCount,
  medianApy,
  bestRiskAdjusted,
}: {
  coveredCount: number;
  trackedCount: number;
  medianApy: number;
  bestRiskAdjusted: YieldRanking | null;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 divide-x divide-border/50">
      <div className="flex flex-col gap-1 px-3 py-3 first:pl-0">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Coverage</span>
        <span className="pharos-numeric text-lg font-semibold text-foreground sm:text-xl">
          {coveredCount}
          <span className="text-sm text-muted-foreground/60">/{trackedCount}</span>
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3 py-3">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Median APY</span>
        <span className="pharos-numeric text-lg font-semibold text-foreground sm:text-xl">
          {formatPercent(medianApy)}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3 py-3">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Best risk-adjusted</span>
        {bestRiskAdjusted ? (
          <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 truncate">
            <span className="truncate font-mono text-sm font-semibold uppercase tracking-tight text-foreground">
              {bestRiskAdjusted.symbol}
            </span>
            <span className="pharos-numeric shrink-0 text-sm font-semibold text-frost-blue">
              {formatPercent(bestRiskAdjusted.apy30d)}
            </span>
            <span className="pharos-numeric shrink-0 text-[11px] text-muted-foreground">
              PYS {formatScore(bestRiskAdjusted.pharosYieldScore)}
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
  row: YieldRanking;
  rank: number;
  logoSrc: string | undefined;
}): React.JSX.Element {
  const grade = row.safetyGrade;
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
          <span className="truncate font-mono text-xs uppercase tracking-tight text-foreground">{row.symbol}</span>
        </span>
        <span className="pharos-numeric justify-self-end text-xs font-semibold text-foreground">
          {formatPercent(row.apy30d)}
        </span>
        <span className="pharos-numeric justify-self-end text-xs text-muted-foreground">
          {formatScore(row.pharosYieldScore)}
        </span>
        <span className="justify-self-end">
          {grade ? (
            <span
              className={`inline-flex items-center rounded border px-1 py-0 font-mono text-[11px] font-semibold ${gradeChipClass(grade)}`}
            >
              {grade}
            </span>
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground/50">—</span>
          )}
        </span>
      </Link>
    </li>
  );
}

export function HomeAltYieldOverview(): React.JSX.Element | null {
  const { data, isLoading } = useYieldRankings();
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
          <span className="font-mono text-sm text-muted-foreground">Yield rankings unavailable</span>
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
        <StatStrip
          coveredCount={overview.coveredCount}
          trackedCount={overview.trackedCount}
          medianApy={overview.medianApy}
          bestRiskAdjusted={overview.bestRiskAdjusted}
        />
        {overview.highestRawYield ? (
          <p className="border-t border-border/50 px-1 py-2 text-[11px] text-muted-foreground">
            Highest raw APY (unadjusted):{" "}
            <span className="font-mono font-semibold uppercase text-foreground">{overview.highestRawYield.symbol}</span>{" "}
            <span className="pharos-numeric font-semibold text-foreground">
              {formatPercent(overview.highestRawYield.apy)}
            </span>
          </p>
        ) : null}

        <div className="mt-3 border-t border-border/50 pt-3">
          <div
            className={`${ROW_GRID} px-1 pb-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground`}
          >
            <span aria-hidden="true" />
            <span>Top by PYS</span>
            <span className="justify-self-end">APY</span>
            <span className="justify-self-end">PYS</span>
            <span className="justify-self-end">Grade</span>
          </div>
          <ul className="flex flex-col">
            {overview.leaders.map((row, index) => (
              <LeaderRow key={row.id} row={row} rank={index + 1} logoSrc={logoMap[row.id]} />
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
