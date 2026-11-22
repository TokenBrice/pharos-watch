"use client";

import { useMemo, useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ShowAllToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { HistorySwitcherSlot } from "@/components/stablecoin-detail/history-tabs";
import { DetailModuleCard } from "@/components/stablecoin-detail/module-title";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { SafetyGradeBadge } from "@/components/safety-scores/safety-grade-badge";
import { useSafetyScoreHistory, useSafetyScoreHistoryV2 } from "@/hooks/api-hooks";
import { CRON_SAFETY_GRADE_HISTORY } from "@/lib/cron-intervals";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { formatChartDate, formatDuration, formatTrackingSpanDays } from "@shared/lib/format";
import { getReportCardGradeRank, gradeRange } from "@shared/lib/report-card-core";
import type {
  ReportCardGrade,
} from "@shared/types/report-card-grade";
import type {
  SafetyScoreHistoryPoint,
  SafetyScoreHistoryV2Point,
  SafetyScoreHistoryV2TransitionKind,
} from "@shared/types/safety-score-history";
import { MethodologyLabel } from "@/components/methodology-hint";
import { DIRECTION_TONE_CLASSES, REPORT_CARD_GRADE_RANGE_METADATA } from "@shared/lib/classification";
import { cn } from "@/lib/utils";

const VISIBLE_CAP = 3;
const DAY_SECONDS = 86_400;

type DisplayHistoryPoint = SafetyScoreHistoryPoint & {
  transitionKind?: SafetyScoreHistoryV2TransitionKind;
};

/** A grade the producer re-baselined rather than an organic grade change. */
const BASELINE_LABELS: Partial<Record<SafetyScoreHistoryV2TransitionKind, string>> = {
  "methodology-boundary-baseline": "Methodology update",
  "rollback-baseline": "Methodology rollback",
  "restoration-baseline": "Methodology restored",
};

/**
 * Indexes of one-day methodology blips: a re-baselined grade that held for at
 * most one day before the history returned to the grade it left. They stay in
 * the list, labelled, but do not set the best/lowest statistic on their own.
 */
export function findMethodologyBlips(history: readonly DisplayHistoryPoint[]): Set<number> {
  const blips = new Set<number>();
  for (let i = 1; i < history.length - 1; i++) {
    const point = history[i];
    if (!point.transitionKind || !BASELINE_LABELS[point.transitionKind]) continue;
    if (history[i + 1].date - point.date > DAY_SECONDS) continue;
    if (history[i - 1].grade === history[i + 1].grade) blips.add(i);
  }
  return blips;
}

export interface LiveGrade {
  grade: ReportCardGrade;
  score: number | null;
}

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

/** One quiet line under the stat tiles, so a note never makes one tile taller than its neighbours. */
function describeBlips(stat: "Best" | "Lowest", blips: readonly DisplayHistoryPoint[]): string {
  const [first] = blips;
  return blips.length === 1
    ? `${stat} grade excludes a one-day methodology blip: ${first.grade}${first.score != null ? ` (${first.score})` : ""}, ${formatChartDate(first.date * 1000, "short")}.`
    : `${stat} grade excludes ${blips.length} one-day methodology blips.`;
}

function StatBox({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("pharos-inset px-3 py-1.5", className)}>
      <p className="pharos-label">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

/**
 * The one row grammar for a grade change: a direction glyph, then "from X".
 * An organic change tints the glyph with its direction; a re-baseline keeps
 * it neutral and adds the methodology tag.
 */
function GradeStep({ step, from, organic }: { step: number; from: ReportCardGrade; organic: boolean }) {
  const glyph = step > 0 ? "▲" : step < 0 ? "▼" : null;
  return (
    <span className="whitespace-nowrap">
      {glyph ? (
        <span className={organic ? DIRECTION_TONE_CLASSES[step > 0 ? "up" : "down"] : undefined} aria-hidden="true">
          {`${glyph} `}
        </span>
      ) : null}
      {organic && glyph ? <span className="sr-only">{step > 0 ? "Upgraded " : "Downgraded "}</span> : null}
      {`from ${from}`}
    </span>
  );
}

function TransitionIndicator({
  point,
  previousGrade,
  blip,
}: {
  point: DisplayHistoryPoint;
  previousGrade: ReportCardGrade | null;
  blip: boolean;
}) {
  const baselineLabel = point.transitionKind ? BASELINE_LABELS[point.transitionKind] : undefined;
  if (baselineLabel) {
    // A re-baselined grade is not an organic change: name where it came from
    // with a neutral glyph and tag the cause, never the up/down tone.
    const from = point.prevGrade ?? previousGrade;
    const step = from == null ? 0 : gradeRank(from) - gradeRank(point.grade);
    return (
      <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {from ? <GradeStep step={step} from={from} organic={false} /> : null}
        <span
          className="whitespace-nowrap rounded-sm border border-dashed border-border px-1.5 py-0.5 text-2xs leading-none"
          title={`${baselineLabel} (methodology v${point.methodologyVersion}): the grade was re-baselined, not changed by the asset.${blip ? " It reverted the next day." : ""}`}
        >
          {blip ? "Methodology · reverted next day" : "Methodology"}
        </span>
      </span>
    );
  }

  if (point.prevGrade == null) {
    return <span className="text-xs text-muted-foreground">Initial grade</span>;
  }

  const step = gradeRank(point.prevGrade) - gradeRank(point.grade);
  if (step > 0 || step < 0) {
    return (
      <span className="text-xs text-muted-foreground">
        <GradeStep step={step} from={point.prevGrade} organic />
      </span>
    );
  }

  return (
    <span className="text-xs text-muted-foreground">
      {point.prevGrade} to {point.grade}
    </span>
  );
}

const GRADE_RANGE_ORDER = ["A", "B", "C", "D", "F", "NR"] as const;

interface SafetyScoreHistorySectionProps {
  stablecoinId: string;
  /**
   * Whether the asset carries a grade in the current publication. `false` ends the
   * claim at the last observation instead of the grade-history cron's writing run;
   * `null` (default) is unknown and keeps the existing lane-bound behaviour.
   */
  currentlyRated?: boolean | null;
  /**
   * The live Safety Score card's grade. History logs one grade per daily close,
   * so when the two disagree the module says which is which instead of letting
   * the latest row pass for the current grade.
   */
  liveGrade?: LiveGrade | null;
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
 * generation bounds the claim. An asset with no grade in the current publication ends at its last
 * observation instead: the grade-history clock is job-wide, so it cannot date a carried-forward grade.
 */
function resolveClaimEndpoint(
  legacy: HistoryLane,
  identityAware: HistoryLane,
  nowSec: number,
  currentlyRated: boolean | null,
): number | null {
  if (currentlyRated === false) return null;
  if (identityAware.data === undefined) return null;
  const lanes = [legacy, identityAware];
  if (lanes.some((lane) => lane.isLoading || (lane.error != null && lane.data === undefined))) return null;
  const generations = lanes.filter((lane) => lane.data !== undefined).map(laneGeneration);
  if (generations.some((generation) => generation === null)) return null;
  return Math.min(nowSec, ...(generations as number[]));
}

export function SafetyScoreHistorySection({
  stablecoinId,
  currentlyRated = null,
  liveGrade = null,
}: SafetyScoreHistorySectionProps) {
  const legacyQuery = useSafetyScoreHistory(stablecoinId, 3650);
  const identityAwareQuery = useSafetyScoreHistoryV2(stablecoinId, 3650);
  const [expanded, setExpanded] = useState(false);

  // Computed once per mount — fresh on each page navigation, avoids module-level staleness
  const [nowSec] = useState(() => Math.floor(Date.now() / 1000));

  const history = useMemo(
    () => mergeGradeHistory(legacyQuery.data ?? [], identityAwareQuery.data?.history ?? []),
    [identityAwareQuery.data, legacyQuery.data],
  );
  const lastDate = history.length > 0 ? history[history.length - 1].date : null;
  const rawEndpoint = resolveClaimEndpoint(legacyQuery, identityAwareQuery, nowSec, currentlyRated);
  // A segment bounded before its own start has no defensible duration.
  const endpoint = rawEndpoint != null && lastDate != null && rawEndpoint >= lastDate ? rawEndpoint : null;

  const blips = useMemo(() => findMethodologyBlips(history), [history]);

  const stats = useMemo(() => {
    if (history.length === 0) return null;

    // NR is not a grade: an all-NR history has no best or lowest grade to name.
    const graded = history.flatMap((point, index) => (point.grade === "NR" ? [] : [{ point, index }]));
    const extremes = (rows: typeof graded) => {
      let best: DisplayHistoryPoint | null = null;
      let worst: DisplayHistoryPoint | null = null;
      // Ties within a grade go to the higher (best) or lower (worst) score.
      const score = (point: DisplayHistoryPoint) => point.score ?? -Infinity;
      for (const { point } of rows) {
        const rank = gradeRank(point.grade);
        if (best === null || rank < gradeRank(best.grade) || (rank === gradeRank(best.grade) && score(point) > score(best))) best = point;
        if (worst === null || rank > gradeRank(worst.grade) || (rank === gradeRank(worst.grade) && score(point) < score(worst))) worst = point;
      }
      return { best, worst };
    };
    // A one-day methodology blip does not set the statistic; it is named instead.
    const settled = graded.filter(({ index }) => !blips.has(index));
    const { best, worst } = extremes(settled.length > 0 ? settled : graded);
    const skipped = settled.length > 0 ? graded.filter(({ index }) => blips.has(index)).map(({ point }) => point) : [];
    const lowerBlips = worst ? skipped.filter((p) => gradeRank(p.grade) > gradeRank(worst.grade)) : [];
    const higherBlips = best ? skipped.filter((p) => gradeRank(p.grade) < gradeRank(best.grade)) : [];

    const lastEntry = history[history.length - 1];
    const streakDays = endpoint == null ? null : Math.max(0, Math.floor((endpoint - lastEntry.date) / DAY_SECONDS));

    return { best, worst, lowerBlips, higherBlips, lastEntry, streakDays };
  }, [blips, endpoint, history]);

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

  const timelineAxis = useMemo(() => {
    if (segments.length === 0) return null;
    const start = segments[0].start;
    const end = segments[segments.length - 1].end;
    const ranges = new Set(segments.map((seg) => gradeRange(seg.grade)));
    return {
      ticks: [start, Math.round((start + end) / 2), end],
      ranges: GRADE_RANGE_ORDER.filter((range) => ranges.has(range)),
    };
  }, [segments]);

  const reversed = useMemo(
    () => history.map((point, index) => ({
      point,
      previousGrade: index > 0 ? history[index - 1].grade : null,
      blip: blips.has(index),
    })).reverse(),
    [blips, history],
  );

  const lastEntry = history.length > 0 ? history[history.length - 1] : null;
  // The live card can move after the daily close the history last logged.
  const liveDiffers = liveGrade != null && lastEntry != null && liveGrade.grade !== lastEntry.grade;
  const lastEntryIsToday = lastEntry != null && Math.floor(lastEntry.date / DAY_SECONDS) === Math.floor(nowSec / DAY_SECONDS);
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

  if (history.length === 0) {
    if (legacyQuery.isLoading || identityAwareQuery.isLoading) return null;
    // Successful empty lanes omit the module; a failed lane with nothing retained is named.
    return laneQueries.some((lane) => lane.error && !lane.hasData)
      ? <StaleDataBanner queries={laneQueries} />
      : null;
  }

  const laneProvenance = laneStamps.map((lane) => `${lane.label} as of ${formatUtcMinute(lane.generation)}`);
  return (
    <DetailModuleCard
      title={<MethodologyLabel topic="safetyScore">Grade History</MethodologyLabel>}
      headerRight={
        <div className="flex flex-wrap items-center gap-2">
          <HistorySwitcherSlot />
          {laneStamps.length > 0 ? (
            // The age chip every module header carries; each lane's own
            // generation stays readable to assistive tech.
            <>
              <FreshnessIndicator
                compact
                updatedAtMs={laneStamps[0].generation * 1000}
                staleAfterMs={CRON_SAFETY_GRADE_HISTORY}
                labelPrefix="Updated"
              />
              <span className="sr-only">{laneProvenance.join(". ")}</span>
            </>
          ) : null}
        </div>
      }
    >
        <StaleDataBanner queries={laneQueries} />
        {stats && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {stats.best && stats.worst ? (
              <>
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
              </>
            ) : null}
            {stats.streakDays != null && endpoint != null ? (
            <StatBox className="col-span-2 sm:col-span-1" label={`Streak as of ${new Date(endpoint * 1000).toISOString().slice(0, 10)}`}>
              <div className="flex items-center gap-1.5">
                <span className="pharos-numeric text-xs font-semibold tabular-nums">
                  {stats.streakDays < 1 ? "<1d" : formatTrackingSpanDays(stats.streakDays)}
                </span>
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

        {stats && (stats.higherBlips.length > 0 || stats.lowerBlips.length > 0) ? (
          <p className="mt-2 text-xs text-muted-foreground" data-grade-history-blip-note="">
            {[
              stats.higherBlips.length > 0 ? describeBlips("Best", stats.higherBlips) : null,
              stats.lowerBlips.length > 0 ? describeBlips("Lowest", stats.lowerBlips) : null,
            ].filter(Boolean).join(" ")}
          </p>
        ) : null}

        {liveDiffers && lastEntry && liveGrade ? (
          <p className="mt-2 text-xs text-muted-foreground" data-grade-history-live-note="">
            {lastEntryIsToday
              ? `History records a daily close: today's row reads ${lastEntry.grade}${lastEntry.score != null ? ` (${lastEntry.score})` : ""}, while the live Safety Score is ${liveGrade.grade}${liveGrade.score != null ? ` (${liveGrade.score})` : ""}.`
              : `The live Safety Score is ${liveGrade.grade}${liveGrade.score != null ? ` (${liveGrade.score})` : ""}; history records daily closes and has not logged it yet.`}
          </p>
        ) : null}

        {segments.length > 0 && timelineAxis && (
          <div className="mt-3">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="pharos-label">Grade timeline</p>
              <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground" aria-label="Timeline legend">
                {timelineAxis.ranges.map((range) => (
                  <li key={range} className="flex items-center gap-1">
                    <span
                      className={cn("h-2 w-2 rounded-full", REPORT_CARD_GRADE_RANGE_METADATA[range].sectionSwatchClassName)}
                      aria-hidden="true"
                    />
                    {range === "NR" ? "Not rated" : `${range} grades`}
                  </li>
                ))}
              </ul>
            </div>
            <TooltipProvider>
              <div
                className="flex h-3 overflow-hidden rounded-full bg-muted"
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
                        {" – "}
                        {formatChartDate(seg.end * 1000, "long")}
                      </p>
                      <p className="text-muted-foreground">{formatDuration(seg.start, seg.end)}</p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </TooltipProvider>
            <div className="pharos-numeric mt-1 grid grid-cols-3 text-2xs text-muted-foreground" aria-hidden="true">
              {timelineAxis.ticks.map((tick, index) => (
                <span key={tick} className={index === 0 ? "text-left" : index === 1 ? "text-center" : "text-right"}>
                  {formatChartDate(tick * 1000, "short-year")}
                </span>
              ))}
            </div>
          </div>
        )}

        <ol className="mt-3 divide-y divide-border/60 rounded-lg border border-border/60">
          {visibleEntries.map(({ point, previousGrade, blip }) => (
            <li
              key={`${point.date}-${point.grade}`}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="pharos-numeric text-xs font-medium tabular-nums">{formatChartDate(point.date * 1000, "short-year")}</span>
                <SafetyGradeBadge
                  grade={point.grade}
                  score={point.score}
                  size="xs"
                  versionTopic="safetyScore"
                  versionVariant="tooltip-only"
                />
              </div>
              <TransitionIndicator point={point} previousGrade={previousGrade} blip={blip} />
            </li>
          ))}
        </ol>

        {hiddenCount > 0 ? (
          <ShowAllToggle
            open={expanded}
            onToggle={() => setExpanded((v) => !v)}
            total={reversed.length}
            noun="grade changes"
            className="mt-1"
          />
        ) : null}
    </DetailModuleCard>
  );
}
