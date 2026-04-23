"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { useSafetyScoreHistory } from "@/hooks/api-hooks";
import { CRON_24H } from "@/lib/cron-intervals";
import {
  formatChartDate,
  formatDuration,
  formatTrackingSpanDays,
} from "@shared/lib/format";
import {
  GRADE_RADAR_COLORS,
  GRADE_THRESHOLDS,
  gradeRange,
} from "@shared/lib/report-cards";
import type { ReportCardGrade, SafetyScoreHistoryPoint } from "@shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VISIBLE_CAP = 3;

/** Rank a grade by position in GRADE_THRESHOLDS (0 = A+ = best). NR = worst. */
function gradeRank(grade: ReportCardGrade): number {
  if (grade === "NR") return Infinity;
  const idx = GRADE_THRESHOLDS.findIndex((t) => t.grade === grade);
  return idx >= 0 ? idx : Infinity;
}

/** Kept exported for backward-compatible test coverage. */
export function describeSafetyScoreTransition(
  point: SafetyScoreHistoryPoint,
): string {
  if (point.prevGrade == null) return "Initial grade";
  return `${point.prevGrade} -> ${point.grade}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatBox({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/45 px-3.5 py-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function TransitionIndicator({ point }: { point: SafetyScoreHistoryPoint }) {
  if (point.prevGrade == null) {
    return <p className="mt-1 text-sm text-muted-foreground">Initial grade</p>;
  }

  const prev = gradeRank(point.prevGrade);
  const curr = gradeRank(point.grade);

  if (curr < prev) {
    return (
      <p className="mt-1 flex items-center gap-1 text-sm text-green-700 dark:text-green-400">
        <ArrowUp className="h-3.5 w-3.5" />
        Upgraded from {point.prevGrade}
      </p>
    );
  }

  if (curr > prev) {
    return (
      <p className="mt-1 flex items-center gap-1 text-sm text-red-700 dark:text-red-400">
        <ArrowDown className="h-3.5 w-3.5" />
        Downgraded from {point.prevGrade}
      </p>
    );
  }

  return (
    <p className="mt-1 text-sm text-muted-foreground">
      {point.prevGrade} to {point.grade}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SafetyScoreHistorySectionProps {
  stablecoinId: string;
}

export function SafetyScoreHistorySection({
  stablecoinId,
}: SafetyScoreHistorySectionProps) {
  const { data, meta, isLoading, error } = useSafetyScoreHistory(stablecoinId, 3650);
  const [expanded, setExpanded] = useState(false);

  // --- derived data --------------------------------------------------------

  // Computed once per mount — fresh on each page navigation, avoids module-level staleness
  const [nowSec] = useState(() => Math.floor(Date.now() / 1000));

  const history = useMemo(() => data ?? [], [data]);

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
    const streakDays = Math.max(0, Math.floor((nowSec - lastEntry.date) / 86400));

    return { best, worst, lastEntry, streakDays };
  }, [history, nowSec]);

  const segments = useMemo(() => {
    if (history.length === 0) return [];
    const totalSpan = nowSec - history[0].date;
    if (totalSpan <= 0) return [];

    return history.map((entry, i) => {
      const start = entry.date;
      const end = i < history.length - 1 ? history[i + 1].date : nowSec;
      const duration = end - start;
      const pct = (duration / totalSpan) * 100;
      const range = gradeRange(entry.grade);
      const color =
        GRADE_RADAR_COLORS[range] ?? GRADE_RADAR_COLORS.NR ?? "#71717a";
      return { grade: entry.grade, start, end, duration, pct, color, isLast: i === history.length - 1 };
    });
  }, [history, nowSec]);

  const reversed = useMemo(() => [...history].reverse(), [history]);
  const visibleEntries = expanded
    ? reversed
    : reversed.slice(0, VISIBLE_CAP);
  const hiddenCount = reversed.length - VISIBLE_CAP;

  // --- early returns -------------------------------------------------------

  if (isLoading) return null;
  if (error) return <QueryErrorNotice error={error} />;
  if (history.length === 0) return null;

  // --- render --------------------------------------------------------------

  return (
    <Card className="rounded-xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-1">
        <DetailSectionTitle>Grade History</DetailSectionTitle>
        {meta?.updatedAt != null && meta.updatedAt > 0 ? (
          <FreshnessIndicator
            updatedAtMs={meta.updatedAt * 1000}
            staleAfterMs={CRON_24H}
            labelPrefix="Updated"
          />
        ) : null}
      </CardHeader>
      <CardContent>
        {/* Summary stats strip */}
        {stats && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatBox label="Best Grade">
              <Badge variant="outline" className={`text-xs px-2 py-0.5 font-medium ${REPORT_CARD_GRADE_COLORS[stats.best.grade]}`} aria-label={`Safety grade ${stats.best.grade}${stats.best.score !== null ? `, score ${stats.best.score}` : ""}`}>{stats.best.grade}{stats.best.score !== null && <span className="ml-1 opacity-70" aria-hidden="true">({stats.best.score})</span>}</Badge>
            </StatBox>
            <StatBox label="Lowest Grade">
              <Badge variant="outline" className={`text-xs px-2 py-0.5 font-medium ${REPORT_CARD_GRADE_COLORS[stats.worst.grade]}`} aria-label={`Safety grade ${stats.worst.grade}${stats.worst.score !== null ? `, score ${stats.worst.score}` : ""}`}>{stats.worst.grade}{stats.worst.score !== null && <span className="ml-1 opacity-70" aria-hidden="true">({stats.worst.score})</span>}</Badge>
            </StatBox>
            <StatBox label="Current Streak">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold tabular-nums">
                  {formatTrackingSpanDays(stats.streakDays)}
                </span>
                <span className="text-sm text-muted-foreground">at</span>
                <Badge variant="outline" className={`text-xs px-2 py-0.5 font-medium ${REPORT_CARD_GRADE_COLORS[stats.lastEntry.grade]}`} aria-label={`Safety grade ${stats.lastEntry.grade}${stats.lastEntry.score !== null ? `, score ${stats.lastEntry.score}` : ""}`}>{stats.lastEntry.grade}{stats.lastEntry.score !== null && <span className="ml-1 opacity-70" aria-hidden="true">({stats.lastEntry.score})</span>}</Badge>
              </div>
            </StatBox>
          </div>
        )}

        {/* Mini grade timeline bar */}
        {segments.length > 0 && (
          <TooltipProvider>
            <div
              className="mt-4 flex h-4 overflow-hidden rounded-full bg-muted"
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
                      aria-label={`${seg.grade}, ${formatChartDate(seg.start * 1000, "long")} to ${seg.isLast ? "now" : formatChartDate(seg.end * 1000, "long")}, ${formatDuration(seg.start, seg.end)}`}
                    />
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">
                    <p className="font-semibold">{seg.grade}</p>
                    <p>
                      {formatChartDate(seg.start * 1000, "long")}
                      {" — "}
                      {seg.isLast
                        ? "Now"
                        : formatChartDate(seg.end * 1000, "long")}
                    </p>
                    <p className="text-muted-foreground">
                      {formatDuration(seg.start, seg.end)}
                    </p>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </TooltipProvider>
        )}

        {/* Transition list */}
        <ol className="mt-4 space-y-3">
          {visibleEntries.map((point) => (
            <li
              key={`${point.date}-${point.grade}`}
              className="rounded-lg border px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {formatChartDate(point.date * 1000, "long")}
                </span>
                <Badge variant="outline" className={`text-xs px-2 py-0.5 font-medium ${REPORT_CARD_GRADE_COLORS[point.grade]}`} aria-label={`Safety grade ${point.grade}${point.score !== null ? `, score ${point.score}` : ""}`}>{point.grade}{point.score !== null && <span className="ml-1 opacity-70" aria-hidden="true">({point.score})</span>}</Badge>
              </div>
              <TransitionIndicator point={point} />
            </li>
          ))}
        </ol>

        {/* Show more / show less */}
        {hiddenCount > 0 && (
          <div className="pt-2 text-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs"
            >
              {expanded
                ? "Show less"
                : `Show ${hiddenCount} more`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
