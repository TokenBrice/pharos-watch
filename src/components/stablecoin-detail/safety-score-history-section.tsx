"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { useSafetyScoreHistory } from "@/hooks/api-hooks";
import { CRON_24H } from "@/lib/cron-intervals";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { formatChartDate, formatDuration, formatTrackingSpanDays } from "@shared/lib/format";
import { getReportCardGradeRank } from "@shared/lib/report-cards";
import type { ReportCardGrade, SafetyScoreHistoryPoint } from "@shared/types";
import { MethodologyLabel } from "@/components/methodology-hint";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VISIBLE_CAP = 3;

/** Lower value = better grade. NR and unknown grades → Infinity (treated as worst for sort comparisons). */
function gradeRank(grade: ReportCardGrade): number {
  if (grade === "NR") return Infinity;
  const rank = getReportCardGradeRank(grade);
  return rank == null ? Infinity : -rank;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/45 px-3 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function TransitionIndicator({ point }: { point: SafetyScoreHistoryPoint }) {
  if (point.prevGrade == null) {
    return <span className="text-xs text-muted-foreground">Initial grade</span>;
  }

  const prev = gradeRank(point.prevGrade);
  const curr = gradeRank(point.grade);

  if (curr < prev) {
    return (
      <span className="flex items-center gap-1 whitespace-nowrap text-xs text-green-700 dark:text-green-400">
        <ArrowUp className="h-3 w-3" />
        Upgraded from {point.prevGrade}
      </span>
    );
  }

  if (curr > prev) {
    return (
      <span className="flex items-center gap-1 whitespace-nowrap text-xs text-red-700 dark:text-red-400">
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

export function SafetyScoreHistorySection({ stablecoinId }: SafetyScoreHistorySectionProps) {
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
      const color = getSafetyGradeMetadata(entry.grade).radarColor;
      return { grade: entry.grade, start, end, duration, pct, color, isLast: i === history.length - 1 };
    });
  }, [history, nowSec]);

  const reversed = useMemo(() => [...history].reverse(), [history]);
  const visibleEntries = expanded ? reversed : reversed.slice(0, VISIBLE_CAP);
  const hiddenCount = reversed.length - VISIBLE_CAP;

  // --- early returns -------------------------------------------------------

  if (isLoading) return null;
  if (error) return <QueryErrorNotice error={error} />;
  if (history.length === 0) return null;

  // --- render --------------------------------------------------------------

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>
          <MethodologyLabel topic="safetyScore">Grade History</MethodologyLabel>
        </DetailSectionTitle>
        {meta?.updatedAt != null && meta.updatedAt > 0 ? (
          <FreshnessIndicator
            compact
            updatedAtMs={meta.updatedAt * 1000}
            staleAfterMs={CRON_24H}
            labelPrefix="Updated"
          />
        ) : null}
      </CardHeader>
      <CardContent className={DETAIL_MODULE_BODY_CLASS}>
        {/* Summary stats strip */}
        {stats && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatBox label="Best Grade">
              <SafetyGradeBadge
                grade={stats.best.grade}
                score={stats.best.score}
                size="xs"
                versionTopic="safetyScore"
                versionVariant="tooltip-only"
              />
            </StatBox>
            <StatBox label="Lowest Grade">
              <SafetyGradeBadge
                grade={stats.worst.grade}
                score={stats.worst.score}
                size="xs"
                versionTopic="safetyScore"
                versionVariant="tooltip-only"
              />
            </StatBox>
            <StatBox label="Current Streak">
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
                      aria-label={`${seg.grade}, ${formatChartDate(seg.start * 1000, "long")} to ${seg.isLast ? "now" : formatChartDate(seg.end * 1000, "long")}, ${formatDuration(seg.start, seg.end)}`}
                    />
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">
                    <p className="font-semibold">{seg.grade}</p>
                    <p>
                      {formatChartDate(seg.start * 1000, "long")}
                      {" — "}
                      {seg.isLast ? "Now" : formatChartDate(seg.end * 1000, "long")}
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
      </CardContent>
    </Card>
  );
}
