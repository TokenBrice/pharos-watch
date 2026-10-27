"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DetailModuleCard } from "@/components/stablecoin-detail/module-title";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { useSafetyScoreHistory, useSafetyScoreHistoryV2 } from "@/hooks/api-hooks";
import { CRON_SAFETY_GRADE_HISTORY } from "@/lib/cron-intervals";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { formatChartDate, formatDuration, formatTrackingSpanDays } from "@shared/lib/format";
import { getReportCardGradeRank } from "@shared/lib/report-card-core";
import type {
  ReportCardGrade,
  SafetyScoreHistoryPoint,
  SafetyScoreHistoryV2Point,
  SafetyScoreHistoryV2TransitionKind,
} from "@shared/types";
import { MethodologyLabel } from "@/components/methodology-hint";
import { DIRECTION_TONE_CLASSES } from "@shared/lib/classification";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VISIBLE_CAP = 3;

type DisplayHistoryPoint = SafetyScoreHistoryPoint & {
  transitionKind?: SafetyScoreHistoryV2TransitionKind;
};

/** Lower value = better grade. NR and unknown grades → Infinity (treated as worst for sort comparisons). */
function gradeRank(grade: ReportCardGrade): number {
  if (grade === "NR") return Infinity;
  const rank = getReportCardGradeRank(grade);
  return rank == null ? Infinity : -rank;
}

function mergeGradeHistory(
  legacyHistory: readonly SafetyScoreHistoryPoint[],
  identityAwareHistory: readonly SafetyScoreHistoryV2Point[],
): DisplayHistoryPoint[] {
  const combined: DisplayHistoryPoint[] = [
    ...legacyHistory,
    ...identityAwareHistory.map((point) => ({
      date: point.date,
      grade: point.grade,
      score: point.score,
      prevGrade: point.prevGrade,
      prevScore: point.prevScore,
      methodologyVersion: point.safetyScoreIdentity.methodologyVersion,
      transitionKind: point.transitionKind,
    })),
  ].sort((left, right) => left.date - right.date);

  const merged: DisplayHistoryPoint[] = [];
  for (const point of combined) {
    const previous = merged[merged.length - 1];
    if (previous?.grade === point.grade) {
      // Prefer the identity-aware copy when both endpoints expose the same row.
      if (previous.date === point.date && previous.transitionKind == null && point.transitionKind != null) {
        merged[merged.length - 1] = point;
      }
      continue;
    }
    merged.push(point);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatBox({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("pharos-inset px-3 py-1.5", className)}>
      <p className="pharos-label">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function TransitionIndicator({ point }: { point: DisplayHistoryPoint }) {
  if (point.transitionKind === "methodology-boundary-baseline") {
    return <span className="text-xs text-muted-foreground">Methodology baseline</span>;
  }
  if (point.transitionKind === "rollback-baseline") {
    return <span className="text-xs text-muted-foreground">Rollback baseline</span>;
  }
  if (point.transitionKind === "restoration-baseline") {
    return <span className="text-xs text-muted-foreground">Restoration baseline</span>;
  }

  if (point.prevGrade == null) {
    return <span className="text-xs text-muted-foreground">Initial grade</span>;
  }

  const prev = gradeRank(point.prevGrade);
  const curr = gradeRank(point.grade);

  if (curr < prev) {
    return (
      <span className={cn("flex items-center gap-1 whitespace-nowrap text-xs", DIRECTION_TONE_CLASSES.up)}>
        <ArrowUp className="h-3 w-3" />
        Upgraded from {point.prevGrade}
      </span>
    );
  }

  if (curr > prev) {
    return (
      <span className={cn("flex items-center gap-1 whitespace-nowrap text-xs", DIRECTION_TONE_CLASSES.down)}>
        <ArrowDown className="h-3 w-3" />
        Downgraded from {point.prevGrade}
      </span>
    );
  }

  return (
    <span className="text-xs text-muted-foreground">
      {point.prevGrade} to {point.grade}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SafetyScoreHistorySectionProps {
  stablecoinId: string;
}

interface HistoryLane {
  data?: unknown;
  error?: unknown;
  isLoading?: boolean;
  dataUpdatedAt?: number;
  meta?: { updatedAt?: number | null } | null;
}

/** A lane's producer generation in seconds; a missing or null clock is unknown, never receipt time. */
function laneGeneration(lane: HistoryLane): number | null {
  const updatedAt = lane.meta?.updatedAt;
  return updatedAt != null && updatedAt > 0 ? updatedAt : null;
}

function formatUtcMinute(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The latest instant the merged history supports. Grade streaks and the open timeline segment end
 * here, never at "now": identity-aware coverage must be readable, no lane may still be loading or
 * missing after a failed read, and every retained lane's generation must be known. The oldest
 * generation bounds the claim.
 */
function resolveClaimEndpoint(legacy: HistoryLane, identityAware: HistoryLane, nowSec: number): number | null {
  if (identityAware.data === undefined) return null;
  const lanes = [legacy, identityAware];
  if (lanes.some((lane) => lane.isLoading || (lane.error != null && lane.data === undefined))) return null;
  const generations = lanes.filter((lane) => lane.data !== undefined).map(laneGeneration);
  if (generations.some((generation) => generation === null)) return null;
  return Math.min(nowSec, ...(generations as number[]));
}

export function SafetyScoreHistorySection({ stablecoinId }: SafetyScoreHistorySectionProps) {
  const legacyQuery = useSafetyScoreHistory(stablecoinId, 3650);
  const identityAwareQuery = useSafetyScoreHistoryV2(stablecoinId, 3650);
  const [expanded, setExpanded] = useState(false);

  // --- derived data --------------------------------------------------------

  // Computed once per mount — fresh on each page navigation, avoids module-level staleness
  const [nowSec] = useState(() => Math.floor(Date.now() / 1000));

  const history = useMemo(
    () => mergeGradeHistory(legacyQuery.data ?? [], identityAwareQuery.data?.history ?? []),
    [identityAwareQuery.data, legacyQuery.data],
  );
  const lastDate = history.length > 0 ? history[history.length - 1].date : null;
  const rawEndpoint = resolveClaimEndpoint(legacyQuery, identityAwareQuery, nowSec);
  // A segment bounded before its own start has no defensible duration.
  const endpoint = rawEndpoint != null && lastDate != null && rawEndpoint >= lastDate ? rawEndpoint : null;

  const stats = useMemo(() => {
    if (history.length === 0) return null;

    const graded = history.filter((p) => p.grade !== "NR");
    const pool = graded.length > 0 ? graded : history;

    let best = pool[0];
    let worst = pool[0];
    for (const p of pool) {
      if (gradeRank(p.grade) < gradeRank(best.grade)) best = p;
      if (gradeRank(p.grade) > gradeRank(worst.grade)) worst = p;
    }

    const lastEntry = history[history.length - 1];
    const streakDays = endpoint == null ? null : Math.max(0, Math.floor((endpoint - lastEntry.date) / 86400));

    return { best, worst, lastEntry, streakDays };
  }, [endpoint, history]);

  const segments = useMemo(() => {
    if (history.length === 0) return [];
    // Without a supported endpoint the open final segment is omitted, not extended to now.
    const spanEnd = endpoint ?? history[history.length - 1].date;
    const totalSpan = spanEnd - history[0].date;
    if (totalSpan <= 0) return [];

    const bounded = endpoint == null ? history.slice(0, -1) : history;
    return bounded.map((entry, i) => {
      const start = entry.date;
      const end = i < history.length - 1 ? history[i + 1].date : spanEnd;
      const duration = end - start;
      const pct = (duration / totalSpan) * 100;
      const color = getSafetyGradeMetadata(entry.grade).radarColor;
      return { grade: entry.grade, start, end, duration, pct, color };
    });
  }, [endpoint, history]);

  const reversed = useMemo(() => [...history].reverse(), [history]);
  const visibleEntries = expanded ? reversed : reversed.slice(0, VISIBLE_CAP);
  const hiddenCount = reversed.length - VISIBLE_CAP;

  // Each lane keeps its own clock and health; a retained lane's failed refresh stays silent.
  const laneQueries = [
    { query: identityAwareQuery, label: "Safety Score history", hasData: identityAwareQuery.data !== undefined },
    { query: legacyQuery, label: "Legacy history", hasData: legacyQuery.data !== undefined },
  ].map(({ query, label, hasData }) => ({
    label,
    staleTime: CRON_SAFETY_GRADE_HISTORY,
    dataUpdatedAt: query.dataUpdatedAt ?? 0,
    error: query.error,
    hasData,
    isLoading: query.isLoading,
    meta: query.meta ?? null,
  }));
  const laneStamps = [
    { label: "Safety Score history", generation: laneGeneration(identityAwareQuery) },
    { label: "Legacy history", generation: laneGeneration(legacyQuery) },
  ].filter((lane): lane is { label: string; generation: number } => lane.generation !== null);

  // --- early returns -------------------------------------------------------

  if (history.length === 0) {
    if (legacyQuery.isLoading || identityAwareQuery.isLoading) return null;
    // Successful empty lanes omit the module; a failed lane with nothing retained is named.
    return laneQueries.some((lane) => lane.error && !lane.hasData)
      ? <StaleDataBanner queries={laneQueries} />
      : null;
  }

  // --- render --------------------------------------------------------------

  const laneProvenance = laneStamps.map((lane) => `${lane.label} as of ${formatUtcMinute(lane.generation)}`);
  return (
    <DetailModuleCard
      title={<MethodologyLabel topic="safetyScore">Grade History</MethodologyLabel>}
      headerRight={laneStamps.length > 0 ? (
        <TooltipProvider delayDuration={220}>
          <Tooltip>
            <TooltipTrigger asChild>
              <time
                tabIndex={0}
                dateTime={new Date(laneStamps[0].generation * 1000).toISOString()}
                className="inline-flex min-h-6 cursor-help items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2 py-0 text-2xs font-medium leading-none text-muted-foreground"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                <span aria-hidden="true">{new Date(laneStamps[0].generation * 1000).toISOString().slice(0, 10)}</span>
                <span className="sr-only">{laneProvenance.join(". ")}</span>
              </time>
            </TooltipTrigger>
            <TooltipContent className="text-2xs">
              {laneProvenance.map((line) => <p key={line}>{line}</p>)}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    >
        <StaleDataBanner queries={laneQueries} />
        {/* Summary stats strip */}
        {stats && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatBox label="Best grade">
              <SafetyGradeBadge
                grade={stats.best.grade}
                score={stats.best.score}
                size="xs"
                versionTopic="safetyScore"
                versionVariant="tooltip-only"
              />
            </StatBox>
            <StatBox label="Lowest grade">
              <SafetyGradeBadge
                grade={stats.worst.grade}
                score={stats.worst.score}
                size="xs"
                versionTopic="safetyScore"
                versionVariant="tooltip-only"
              />
            </StatBox>
            {stats.streakDays != null && endpoint != null ? (
            <StatBox className="col-span-2 sm:col-span-1" label={`Streak as of ${new Date(endpoint * 1000).toISOString().slice(0, 10)}`}>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold tabular-nums">{formatTrackingSpanDays(stats.streakDays)}</span>
                <span className="text-xs text-muted-foreground">at</span>
                <SafetyGradeBadge
                  grade={stats.lastEntry.grade}
                  score={stats.lastEntry.score}
                  size="xs"
                  versionTopic="safetyScore"
                  versionVariant="tooltip-only"
                />
              </div>
            </StatBox>
            ) : null}
          </div>
        )}

        {/* Mini grade timeline bar */}
        {segments.length > 0 && (
          <TooltipProvider>
            <div
              className="mt-3 flex h-3 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`Grade timeline: ${segments.map((seg) => `${seg.grade} for ${formatDuration(seg.start, seg.end)}`).join(", ")}`}
            >
              {segments.map((seg) => (
                <Tooltip key={`${seg.grade}-${seg.start}`}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="h-full first:rounded-l-full last:rounded-r-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                      style={{
                        width: `${seg.pct}%`,
                        backgroundColor: seg.color,
                        minWidth: "2px",
                      }}
                      aria-label={`${seg.grade}, ${formatChartDate(seg.start * 1000, "long")} to ${formatChartDate(seg.end * 1000, "long")}, ${formatDuration(seg.start, seg.end)}`}
                    />
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">
                    <p className="font-semibold">{seg.grade}</p>
                    <p>
                      {formatChartDate(seg.start * 1000, "long")}
                      {" — "}
                      {formatChartDate(seg.end * 1000, "long")}
                    </p>
                    <p className="text-muted-foreground">{formatDuration(seg.start, seg.end)}</p>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </TooltipProvider>
        )}

        {/* Transition list */}
        <ol className="mt-3 divide-y divide-border/60 rounded-lg border border-border/60">
          {visibleEntries.map((point) => (
            <li
              key={`${point.date}-${point.grade}`}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-xs font-medium tabular-nums">{formatChartDate(point.date * 1000, "long")}</span>
                <SafetyGradeBadge
                  grade={point.grade}
                  score={point.score}
                  size="xs"
                  versionTopic="safetyScore"
                  versionVariant="tooltip-only"
                />
              </div>
              <TransitionIndicator point={point} />
            </li>
          ))}
        </ol>

        {/* Show more / show less */}
        {hiddenCount > 0 && (
          <div className="pt-1 text-center">
            <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} className="h-7 text-xs">
              {expanded ? "Show less" : `Show ${hiddenCount} more`}
            </Button>
          </div>
        )}
    </DetailModuleCard>
  );
}
