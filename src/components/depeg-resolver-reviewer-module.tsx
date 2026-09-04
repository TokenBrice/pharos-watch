"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CoinLockup } from "@/components/depeg-resolver-row-card-shared";
import { DdrInfoTooltip } from "@/components/depeg-resolver-info-tooltip";
import { isDepegResolverReviewerEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import { formatElapsedSeconds } from "@shared/lib/format";
import {
  DDRR_PUBLIC_WARNING,
  type DdrrResponse,
  type DdrrRow,
  type DdrrSummary,
} from "@shared/types/depeg-resolver-review";
import {
  DDR_COVERAGE_LABELS,
  DDR_COVERAGE_TONES,
  DDR_DURATION_LABELS,
  DDR_OUTCOME_LABELS,
  DDR_VERDICT_LABELS,
  DDR_VERDICT_TONES,
  buildDdrReviewerRows,
  buildDdrTimelineModel,
  formatMetricPercent,
  formatPercent,
  formatDdrSignedDuration,
  getActualOutcome,
  getCoverageMetric,
  getCoverageState,
  getDurationReview,
  getRowContextLabel,
  getRowTime,
  getSignedDurationError,
  getVerdictReview,
  isScored,
  nodeKind,
  summarizeAccuracyByMajor,
  summarizePredictionRows,
  type NodeKind,
} from "@/lib/depeg-resolver-review-presentation";

interface DepegResolverReviewerModuleProps {
  data: DdrrResponse | undefined;
  error?: Error | null;
  logos?: Record<string, string>;
}

/** Below this many scored verdicts, accuracy is presented as a raw fraction, not a percentage. */
const CALIBRATION_THRESHOLD = 5;
const ROW_DISPLAY_LIMIT = 8;
/** Track-record timeline node cap — enough to read the streak without clutter. */
const TIMELINE_NODE_LIMIT = 36;

// --- track-record timeline -------------------------------------------------

/**
 * Vertical seat encodes outcome: correct calls ride above the rail, misses drop
 * below it, risk-noted sits just above, maturing/unscored stay on the line. So the
 * track record reads at a glance — a mostly-high run is a mostly-right engine.
 */
const NODE_TONE: Record<NodeKind, { dot: string; pos: string }> = {
  correct: { dot: "bg-emerald-500", pos: "top-1" },
  risk: { dot: "bg-amber-500", pos: "top-3" },
  pending: { dot: "bg-sky-500/20 ring-1 ring-inset ring-sky-500", pos: "top-1/2 -translate-y-1/2" },
  miss: { dot: "bg-red-500", pos: "bottom-1" },
  muted: { dot: "bg-muted-foreground/30", pos: "top-1/2 -translate-y-1/2" },
};

function TrackRecordTimeline({ rows }: { rows: DdrrRow[] }) {
  // Oldest call on the left, the most recent at "now" on the right.
  const { rows: ordered, correct, miss, pending } = buildDdrTimelineModel(rows, TIMELINE_NODE_LIMIT);
  if (ordered.length === 0) return null;

  return (
    <div
      className="relative h-14 w-full"
      role="img"
      aria-label={`Track record across ${ordered.length} graded DDR outcomes: ${correct} correct, ${miss} missed, ${pending} still maturing, oldest left, most recent right.`}
    >
      {/* the rail */}
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" aria-hidden="true" />
      {/* now cap */}
      <span className="absolute right-0 top-1/2 h-3 w-px -translate-y-1/2 bg-foreground/40" aria-hidden="true" />
      <span className="pharos-meta pharos-numeric absolute -top-0.5 right-0 uppercase tracking-wide">
        now
      </span>

      {ordered.map((row, i) => {
        const coverageState = getCoverageState(row);
        const kind = coverageState && !isScored(row) ? "muted" : nodeKind(getVerdictReview(row));
        const tone = NODE_TONE[kind];
        const left = ordered.length === 1 ? 50 : (i / (ordered.length - 1)) * 96 + 2;
        return (
          <span
            key={`${row.eventId}:${row.kind}:${getRowTime(row)}`}
            className={cn("absolute h-2 w-2 -translate-x-1/2 rounded-full", tone.dot, tone.pos)}
            style={{ left: `${left}%` }}
            title={`${row.symbol} · ${
              coverageState ? DDR_COVERAGE_LABELS[coverageState] : DDR_VERDICT_LABELS[getVerdictReview(row)]
            } · ${DDR_OUTCOME_LABELS[getActualOutcome(row)]}`}
            aria-hidden="true"
          />
        );
      })}
    </div>
  );
}

// --- primitives ------------------------------------------------------------

function Kicker({ children }: { children: ReactNode }) {
  return <p className="pharos-kicker">{children}</p>;
}

/** Scored-vs-maturing progress: a filled segment over a muted track plus a count caption. */
function CalibrationBar({ scored, maturing }: { scored: number; maturing: number }) {
  const total = scored + maturing;
  const scoredPct = total > 0 ? (scored / total) * 100 : 0;
  return (
    <div className="space-y-1.5">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${scored} scored of ${total}, ${maturing} still maturing`}
      >
        <div className="h-full rounded-full bg-foreground/55" style={{ width: `${scoredPct}%` }} />
      </div>
      <p className="pharos-meta pharos-numeric">
        {scored} scored · {maturing} maturing
      </p>
    </div>
  );
}

function BreakdownStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "emerald" | "red" | "muted";
}) {
  const color =
    tone === "emerald"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "red"
        ? "text-red-700 dark:text-red-400"
        : "text-foreground";
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={cn("pharos-numeric text-sm font-semibold", color)}>{value}</span>
      <span className="pharos-meta">{label}</span>
    </div>
  );
}

function VersionAccuracyStrip({ summary }: { summary: DdrrSummary }) {
  const segments = summarizeAccuracyByMajor(summary);
  if (segments.filter((segment) => segment.scored > 0).length < 2) {
    return null;
  }
  return (
    <div className="mt-4 border-t border-border/50 pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <Kicker>Accuracy by version</Kicker>
        <span className="pharos-meta">
          sub-versions consolidated into majors
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        {segments.map((segment) => (
          <div key={segment.major} className="flex items-center gap-3">
            <span className="pharos-numeric w-7 shrink-0 font-semibold text-foreground">
              {segment.major}
            </span>
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={
                segment.accuracy != null
                  ? `${segment.major}: ${segment.correct} of ${segment.scored} recovery calls correct`
                  : `${segment.major}: no scored recovery calls yet`
              }
            >
              {segment.accuracy != null ? (
                <div
                  className="h-full rounded-full bg-emerald-500/80"
                  style={{ width: `${segment.accuracy * 100}%` }}
                />
              ) : null}
            </div>
            <span className="pharos-meta pharos-numeric w-36 shrink-0 whitespace-nowrap text-right">
              {segment.accuracy != null
                ? `${formatPercent(segment.accuracy)} · ${segment.scored} scored`
                : "maturing · 0 scored"}
            </span>
            <span
              className="pharos-meta pharos-numeric hidden w-24 shrink-0 text-right sm:inline"
              aria-label={
                segment.meanSignedDurationErrorSec != null
                  ? `${segment.major}: mean duration miss ${formatDdrSignedDuration(segment.meanSignedDurationErrorSec)}`
                  : undefined
              }
            >
              {segment.meanSignedDurationErrorSec != null
                ? `${formatDdrSignedDuration(segment.meanSignedDurationErrorSec)} ±${formatElapsedSeconds(
                    Math.round(segment.meanAbsoluteDurationErrorSec ?? 0),
                  )} miss`
                : "— miss"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CalibrationLedger({ summary, rows }: { summary: DdrrSummary; rows: readonly DdrrRow[] }) {
  const metrics = summary.headline;
  const rowBreakdown = summarizePredictionRows(rows);
  const correct = metrics.recoveryLikelihoodCorrectCount;
  const scored = metrics.recoveryLikelihoodScoredCount;
  const pct = metrics.recoveryLikelihoodAccuracyPct;
  const durationScored = metrics.durationScoredCount;
  const pending = metrics.pendingLockCount;

  const recoveryValue = scored > 0 ? `${correct} / ${scored}` : "—";
  const recoveryCaption =
    scored === 0
      ? "none scored yet"
      : scored >= CALIBRATION_THRESHOLD && pct != null
        ? `correct · ${formatPercent(pct)}`
        : "correct so far";

  return (
    <div className="pharos-card-shell p-4 sm:p-5">
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        <div className="space-y-2.5">
          <Kicker>Recovery calls</Kicker>
          <div className="flex items-baseline gap-2">
            <span className="pharos-numeric text-2xl font-semibold text-foreground">
              {recoveryValue}
            </span>
            <span className="text-xs text-muted-foreground">{recoveryCaption}</span>
          </div>
          <CalibrationBar scored={scored} maturing={pending} />
        </div>

        <div className="space-y-2.5 sm:border-l sm:border-border/50 sm:pl-6">
          <Kicker>Duration calls</Kicker>
          <div className="flex items-baseline gap-2">
            {durationScored > 0 ? (
              <>
                <span className="pharos-numeric text-2xl font-semibold text-foreground">
                  {formatDdrSignedDuration(metrics.meanSignedDurationErrorSec)}
                </span>
                <span className="text-xs text-muted-foreground">
                  mean miss · ±
                  {formatElapsedSeconds(metrics.meanAbsoluteDurationErrorSec ?? 0)}
                </span>
              </>
            ) : (
              <>
                <span className="pharos-numeric text-2xl font-semibold text-muted-foreground">
                  —
                </span>
                <span className="text-xs text-muted-foreground">not yet scored</span>
              </>
            )}
          </div>
          <p className="pharos-meta pharos-numeric">{durationScored} duration outcomes scored</p>
        </div>
      </div>

      <VersionAccuracyStrip summary={summary} />

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-border/50 pt-3">
        <BreakdownStat
          label="false terminal"
          value={rowBreakdown.falseTerminal}
          tone={rowBreakdown.falseTerminal > 0 ? "red" : "muted"}
        />
        <BreakdownStat
          label="false recoverable"
          value={rowBreakdown.falseRecoverable}
          tone={rowBreakdown.falseRecoverable > 0 ? "red" : "muted"}
        />
        <BreakdownStat
          label="inside typical range"
          value={`${rowBreakdown.withinIqrCount}/${rowBreakdown.iqrScoredCount}`}
        />
      </div>
    </div>
  );
}

function CoverageAccountabilityLedger({
  summary,
}: {
  summary: DdrrSummary;
}) {
  const metrics = summary.headline;
  const policyUniverseCount = metrics.policyUniverseIncidentCount;
  const metricCards = [
    {
      label: "Scoreable coverage",
      value: formatMetricPercent(getCoverageMetric(metrics, "scoreableCoveragePct")),
    },
    {
      label: "Prediction coverage",
      value: formatMetricPercent(getCoverageMetric(metrics, "predictionCoveragePct")),
    },
    {
      label: "Publication success",
      value: formatMetricPercent(getCoverageMetric(metrics, "publicationSuccessPct")),
    },
    {
      label: "No-call share",
      value: formatMetricPercent(getCoverageMetric(metrics, "noCallSharePct")),
    },
    {
      label: "Invalidation rate",
      value: formatMetricPercent(getCoverageMetric(metrics, "invalidationRatePct")),
    },
  ];

  return (
    <div className="pharos-card-shell p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Kicker>Coverage accountability</Kicker>
        <span className="pharos-meta pharos-numeric">
          {policyUniverseCount.toLocaleString()} policy-universe incidents
        </span>
      </div>
      <div className="pharos-subtle-band mt-3 grid grid-cols-1 divide-y divide-border/50 p-0 md:grid-cols-5 md:divide-x md:divide-y-0">
        {metricCards.map((metric) => (
          <div key={metric.label} className="min-w-0 px-3 py-2.5">
            <p className="pharos-meta truncate">{metric.label}</p>
            <p className="pharos-numeric mt-1 text-lg font-semibold text-foreground">{metric.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Headline accuracy reviews frozen outcomes only after first public publication. No-calls, missed locks,
        publication failures, and invalidations remain in coverage even when they are not scoreable accuracy rows.
      </p>
    </div>
  );
}

function ReviewRow({ row, logos }: { row: DdrrRow; logos?: Record<string, string> }) {
  const coverageState = getCoverageState(row);
  const scored = isScored(row);
  const verdictReview = getVerdictReview(row);
  const durationReview = getDurationReview(row);
  const actualOutcome = getActualOutcome(row);
  const signedDurationErrorSec = getSignedDurationError(row);
  const verdictLabel = coverageState ? DDR_COVERAGE_LABELS[coverageState] : DDR_VERDICT_LABELS[verdictReview];
  const verdictStyle = coverageState ? DDR_COVERAGE_TONES[coverageState] : DDR_VERDICT_TONES[verdictReview];
  const durationText =
    signedDurationErrorSec == null
      ? DDR_DURATION_LABELS[durationReview]
      : `${formatDdrSignedDuration(signedDurationErrorSec)} ${DDR_DURATION_LABELS[durationReview]}`;

  // Two stacked lines on mobile (identity never shrinks to nothing), one row on sm+.
  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2.5",
        "sm:grid-cols-[minmax(0,1.7fr)_minmax(0,1.2fr)_auto_auto]",
        scored ? "" : "opacity-80",
      )}
    >
      <div className="min-w-0 sm:col-start-1 sm:row-start-1">
        <CoinLockup row={row} logos={logos} logoSize={22} />
      </div>
      <Badge
        variant="outline"
        className={cn(
          "justify-self-end text-xs sm:col-start-3 sm:row-start-1 sm:justify-self-start",
          verdictStyle,
        )}
      >
        {verdictLabel}
      </Badge>
      <span className="pharos-meta pharos-numeric justify-self-start uppercase tracking-wide sm:col-start-2 sm:row-start-1 sm:justify-self-end sm:text-right">
        {getRowContextLabel(row)} · {DDR_OUTCOME_LABELS[actualOutcome]}
      </span>
      <span className="pharos-meta pharos-numeric justify-self-end sm:col-start-4 sm:row-start-1 sm:whitespace-nowrap">
        {durationText}
      </span>
    </li>
  );
}

function ReviewLegend() {
  const items: Array<{ tone: string; label: string }> = [
    { tone: "bg-emerald-500", label: "correct" },
    { tone: "bg-red-500", label: "miss" },
    { tone: "bg-sky-500", label: "pending" },
  ];
  return (
    <div className="pharos-meta hidden items-center gap-3 sm:flex">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1">
          <span className={cn("h-1.5 w-1.5 rounded-full", item.tone)} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  );
}

// --- module header ---------------------------------------------------------

function ReviewerHeader({ calibrating, data }: { calibrating: boolean; data: DdrrResponse | undefined }) {
  const meta = data?._meta;
  const assessed = data?._meta.assessedEventCount ?? 0;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-2.5">
          <span className="rounded-md bg-foreground px-1.5 py-0.5 font-mono text-xs font-bold tracking-wide text-background">
            DDRR
          </span>
          <h2 className="pharos-section-title">Depeg Duration Resolver Reviewer</h2>
          <Badge
            variant="outline"
            className={cn(
              "px-1.5 py-0 text-xs uppercase tracking-wide",
              calibrating
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "border-border/60 bg-muted/40 text-muted-foreground",
            )}
          >
            {calibrating ? "Calibrating" : "Review"}
          </Badge>
          <DdrInfoTooltip
            ariaLabel="About the Depeg Duration Resolver Reviewer"
            maxWidth="wide"
            content={
              <>
                Each stored DDR readout is graded against later confirmed event data. Open events stay pending unless
                terminal lifecycle evidence, such as frozen or dead status, matures the call.
              </>
            }
          />
        </div>
        {meta ? (
          <p className="pharos-meta pharos-numeric">
            comparing {assessed} stored readouts
          </p>
        ) : null}
      </div>
      <p className="text-pretty text-sm text-muted-foreground">
        Grades frozen, first-published DDR predictions against what actually happened and keeps the coverage debt
        visible - <span className="text-foreground">the wins, misses, no-calls, and gaps</span>, never cherry-picked.
      </p>
    </div>
  );
}

function ReviewerNote({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {text}
    </p>
  );
}

// --- public component -------------------------------------------------------

/**
 * Loading fallback that reserves the rendered height of the reviewer's header,
 * calibration + coverage ledgers, and track-record timeline. Use as a lazy-load
 * `loading` fallback or while reviewer data is in flight so the section does not
 * produce a layout shift when content arrives. Mirrors the feature-flag gate of
 * the module itself.
 */
export function DepegResolverReviewerSkeleton() {
  if (!isDepegResolverReviewerEnabled()) return null;

  return (
    <section aria-label="Depeg Duration Resolver Reviewer" aria-busy className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-5 w-24" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>

      <div className="space-y-2.5">
        <Skeleton className="h-4 w-28" />
        <div className="pharos-card-shell px-4 py-3 sm:px-5">
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </div>

      <div className="space-y-2.5">
        <Skeleton className="h-4 w-36" />
        <div className="space-y-px overflow-hidden rounded-xl border border-border/60 bg-card/40">
          <Skeleton className="h-14 w-full rounded-none" />
          <Skeleton className="h-14 w-full rounded-none" />
          <Skeleton className="h-14 w-full rounded-none" />
        </div>
      </div>
    </section>
  );
}

export function DepegResolverReviewerModule({ data, error, logos }: DepegResolverReviewerModuleProps) {
  if (!isDepegResolverReviewerEnabled()) return null;

  if (error && !data) {
    return (
      <section aria-label="Depeg Duration Resolver Reviewer" className="space-y-4">
        <ReviewerHeader calibrating data={undefined} />
        <ReviewerNote text={DDRR_PUBLIC_WARNING} />
        <div className="pharos-empty-note text-center">Reviewer data is temporarily unavailable.</div>
      </section>
    );
  }

  const summary = data?.summary;
  const rows = data?.rows ?? [];
  const calibrating = (summary?.headline.recoveryLikelihoodScoredCount ?? 0) < CALIBRATION_THRESHOLD;

  // Scored rows carry the signal; surface them first, then a capped run of maturing rows.
  const { shownRows, hiddenCount, trackRecordRows } = buildDdrReviewerRows(rows, ROW_DISPLAY_LIMIT);

  return (
    <section aria-label="Depeg Duration Resolver Reviewer" className="space-y-4">
      <ReviewerHeader calibrating={calibrating} data={data} />

      {!data || !summary ? (
        <div className="pharos-empty-note text-center">Reviewer data is loading.</div>
      ) : data._meta.degraded && rows.length === 0 ? (
        <div className="pharos-empty-note text-center">Reviewer data is temporarily unavailable.</div>
      ) : rows.length === 0 ? (
        <div className="pharos-empty-note">
          <p className="font-medium text-foreground">No readouts have matured yet.</p>
          <p className="mt-1">
            As open depeg events close, each prior DDR readout is graded against the confirmed
            outcome and its accuracy appears here.
          </p>
        </div>
      ) : (
        <>
          <CalibrationLedger summary={summary} rows={rows} />
          <CoverageAccountabilityLedger summary={summary} />
          <ReviewerNote text={data._meta.publicWarning ?? DDRR_PUBLIC_WARNING} />

          {data._meta.degraded ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              Reviewer snapshot is degraded: {data._meta.degradedReason ?? "unknown"}.
            </p>
          ) : null}

          {/* Track record — every graded call on one time axis, oldest to now */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <Kicker>Track record</Kicker>
              <ReviewLegend />
            </div>
            <div className="pharos-card-shell px-4 py-3 sm:px-5">
              <TrackRecordTimeline rows={trackRecordRows} />
              <div className="pharos-meta pharos-numeric mt-1 flex justify-between uppercase tracking-wide">
                <span>older calls</span>
                <span>recent</span>
              </div>
            </div>
          </div>

          {/* The record itself, row by row */}
          <div className="space-y-2.5">
            <Kicker>Reviewed readouts</Kicker>
            <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card/40">
              {shownRows.map((row) => (
                <ReviewRow key={`${row.eventId}:${row.kind}:${getRowTime(row)}`} row={row} logos={logos} />
              ))}
            </ul>
            {hiddenCount > 0 ? (
              <p className="pharos-meta pharos-numeric px-1">
                +{hiddenCount} more reviewer rows
              </p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
