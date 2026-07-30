"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CoinLockup } from "@/components/depeg-resolver-row-card-shared";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isDepegResolverReviewerEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import { formatElapsedSeconds, formatPercentFromRatio } from "@shared/lib/format";
import {
  DDRR_PUBLIC_WARNING,
  type DdrrActualOutcome,
  type DdrrDurationReview,
  type DdrrResponse,
  type DdrrRow,
  type DdrrSummary,
  type DdrrVerdictReview,
} from "@shared/types/depeg-resolver-review";

interface DepegResolverReviewerModuleProps {
  data: DdrrResponse | undefined;
  error?: Error | null;
  logos?: Record<string, string>;
}

type DdrrCoverageState =
  Exclude<DdrrRow["predictionState"], "frozen">;
type DdrrHeadlineMetrics = DdrrSummary["headline"];
type CoverageMetricKey =
  | "scoreableCoveragePct"
  | "predictionCoveragePct"
  | "publicationSuccessPct"
  | "noCallSharePct"
  | "invalidationRatePct";

/** Below this many scored verdicts, accuracy is presented as a raw fraction, not a percentage. */
const CALIBRATION_THRESHOLD = 5;
const ROW_DISPLAY_LIMIT = 8;
/** Track-record timeline node cap — enough to read the streak without clutter. */
const TIMELINE_NODE_LIMIT = 36;

const VERDICT_LABELS: Record<DdrrVerdictReview, string> = {
  correct_recoverable: "Correct recoverable",
  correct_terminal: "Correct terminal",
  false_terminal: "False terminal",
  false_recoverable: "False recoverable",
  risk_noted_terminal: "Risk noted",
  unscored_insufficient_signal: "Unscored",
  pending: "Pending",
  data_issue: "Data issue",
};

const VERDICT_STYLES: Record<DdrrVerdictReview, string> = {
  correct_recoverable: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  correct_terminal: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  false_terminal: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  false_recoverable: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  risk_noted_terminal: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  unscored_insufficient_signal: "border-border bg-muted text-muted-foreground",
  pending: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  data_issue: "border-border bg-muted text-muted-foreground",
};

const OUTCOME_LABELS: Record<DdrrActualOutcome, string> = {
  recovered: "recovered",
  terminal: "terminal observed",
  orphan_closed: "closed without recovery",
  still_open: "still open",
  source_missing: "source missing",
  data_issue: "data issue",
  invalidated: "invalidated",
};

const DURATION_LABELS: Record<DdrrDurationReview, string> = {
  inside_band: "inside band",
  faster_than_band: "faster than band",
  slower_than_band: "slower than band",
  median_late_by: "late vs median",
  median_early_by: "early vs median",
  median_exact: "exact median",
  duration_unscored: "unscored",
  data_issue: "data issue",
};

const COVERAGE_LABELS: Record<DdrrCoverageState, string> = {
  pending_lock: "pending lock",
  lock_deferred: "lock deferred",
  data_quality_gap: "data quality gap",
  orphan_closed: "orphan closed",
  publication_retry_pending: "publication retry",
  resolved_before_prediction: "resolved before lock",
  terminal_before_prediction: "terminal before lock",
  missed_lock_recovered: "missed recovered",
  missed_lock_terminal: "missed terminal",
  publication_failed: "publication failed",
  no_call: "no-call",
  invalidated: "invalidated",
};

const COVERAGE_STYLES: Record<DdrrCoverageState, string> = {
  pending_lock: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  lock_deferred: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  data_quality_gap: "border-border bg-muted text-muted-foreground",
  orphan_closed: "border-border bg-muted text-muted-foreground",
  publication_retry_pending: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
  resolved_before_prediction: "border-border bg-background text-muted-foreground",
  terminal_before_prediction: "border-border bg-background text-muted-foreground",
  missed_lock_recovered: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  missed_lock_terminal: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  publication_failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  no_call: "border-border bg-muted text-muted-foreground",
  invalidated: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
};

/** Verdict reviews that count as a real, scored result (vs. still maturing). */
const SCORED_VERDICTS = new Set<DdrrVerdictReview>([
  "correct_recoverable",
  "correct_terminal",
  "false_terminal",
  "false_recoverable",
  "risk_noted_terminal",
]);

function isScored(row: DdrrRow): boolean {
  return row.kind === "prediction_review" && SCORED_VERDICTS.has(row.verdictReview);
}

function isTrackRecordRow(row: DdrrRow): boolean {
  return row.kind === "prediction_review";
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return formatPercentFromRatio(value, Number.isInteger(value * 100) ? 0 : 1);
}

function formatSignedDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "N/A";
  const rounded = Math.round(seconds);
  if (rounded === 0) return "0s";
  return `${rounded > 0 ? "+" : "−"}${formatElapsedSeconds(Math.abs(rounded))}`;
}

function getCoverageState(row: DdrrRow): DdrrCoverageState | null {
  return row.predictionState === "frozen" ? null : row.predictionState;
}

function formatMetricPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatPercent(value);
}

function getVerdictReview(row: DdrrRow): DdrrVerdictReview {
  if (row.kind === "prediction_review" || row.kind === "no_call_review") return row.verdictReview;
  return "pending";
}

function getDurationReview(row: DdrrRow): DdrrDurationReview {
  if (row.kind === "prediction_review" || row.kind === "no_call_review") return row.durationReview;
  return "duration_unscored";
}

function sourceEventStateToActualOutcome(sourceEventState: DdrrRow["sourceEventState"]): DdrrActualOutcome {
  switch (sourceEventState) {
    case "active":
      return "still_open";
    case "missing":
      return "source_missing";
    case "recovered":
    case "terminal":
    case "orphan_closed":
    case "data_issue":
    case "invalidated":
      return sourceEventState;
  }
  const exhaustive: never = sourceEventState;
  return exhaustive;
}

function getActualOutcome(row: DdrrRow): DdrrActualOutcome {
  if (row.kind === "prediction_review" || row.kind === "no_call_review") {
    return row.actual.kind;
  }
  return sourceEventStateToActualOutcome(row.sourceEventState);
}

function getRowContextLabel(row: DdrrRow): string {
  switch (row.kind) {
    case "prediction_review":
      return "Public prediction";
    case "no_call_review":
      return "No-call";
    case "invalidated_prediction":
      return row.originalKind === "no_call" ? "Invalidated no-call" : "Invalidated prediction";
    case "coverage":
      return "Coverage";
  }
}

function getRowTime(row: DdrrRow): number {
  switch (row.kind) {
    case "prediction_review":
    case "no_call_review":
      return row.publishedAt;
    case "invalidated_prediction":
      return row.publishedAt ?? row.lockedAt;
    case "coverage":
      return row.actualEndedAt ?? row.terminalEvidenceAt ?? row.eligibleAt ?? row.startedAt;
  }
}

function getSignedDurationError(row: DdrrRow): number | null {
  return row.kind === "prediction_review" ? row.signedDurationErrorSec : null;
}

function summarizePredictionRows(rows: readonly DdrrRow[]) {
  return rows.reduce(
    (breakdown, row) => {
      if (row.kind !== "prediction_review") return breakdown;
      if (row.verdictReview === "correct_recoverable") breakdown.correctRecoverable += 1;
      if (row.verdictReview === "correct_terminal") breakdown.correctTerminal += 1;
      if (row.verdictReview === "false_terminal") breakdown.falseTerminal += 1;
      if (row.verdictReview === "false_recoverable") breakdown.falseRecoverable += 1;
      if (row.withinIqr != null) {
        breakdown.iqrScoredCount += 1;
        if (row.withinIqr) breakdown.withinIqrCount += 1;
      }
      return breakdown;
    },
    {
      correctRecoverable: 0,
      correctTerminal: 0,
      falseTerminal: 0,
      falseRecoverable: 0,
      withinIqrCount: 0,
      iqrScoredCount: 0,
    },
  );
}

// --- track-record timeline -------------------------------------------------

type NodeKind = "correct" | "miss" | "risk" | "pending" | "muted";

function nodeKind(verdict: DdrrVerdictReview): NodeKind {
  switch (verdict) {
    case "correct_recoverable":
    case "correct_terminal":
      return "correct";
    case "false_terminal":
    case "false_recoverable":
      return "miss";
    case "risk_noted_terminal":
      return "risk";
    case "pending":
      return "pending";
    default:
      return "muted";
  }
}

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
  const ordered = [...rows]
    .sort((a, b) => getRowTime(a) - getRowTime(b))
    .slice(-TIMELINE_NODE_LIMIT);
  if (ordered.length === 0) return null;

  const correct = ordered.filter((r) => nodeKind(getVerdictReview(r)) === "correct").length;
  const miss = ordered.filter((r) => nodeKind(getVerdictReview(r)) === "miss").length;
  const pending = ordered.filter((r) => nodeKind(getVerdictReview(r)) === "pending").length;

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
      <span className="absolute -top-0.5 right-0 font-mono text-[8px] uppercase tracking-wide text-muted-foreground">
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
              coverageState ? COVERAGE_LABELS[coverageState] : VERDICT_LABELS[getVerdictReview(row)]
            } · ${OUTCOME_LABELS[getActualOutcome(row)]}`}
            aria-hidden="true"
          />
        );
      })}
    </div>
  );
}

// --- primitives ------------------------------------------------------------

function Kicker({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </p>
  );
}

/** Scored-vs-maturing progress: a filled segment over a muted track plus a count caption. */
function CalibrationBar({
  scored,
  maturing,
  tone,
}: {
  scored: number;
  maturing: number;
  tone: "emerald" | "cyan";
}) {
  const total = scored + maturing;
  const scoredPct = total > 0 ? (scored / total) * 100 : 0;
  const fill = tone === "emerald" ? "bg-emerald-500/80" : "bg-cyan-500/80";
  return (
    <div className="space-y-1.5">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${scored} scored of ${total}, ${maturing} still maturing`}
      >
        <div className={cn("h-full rounded-full", fill)} style={{ width: `${scoredPct}%` }} />
      </div>
      <p className="font-mono text-[10px] text-muted-foreground">
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
      <span className={cn("font-mono text-sm font-semibold tabular-nums", color)}>{value}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
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
            <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
              {recoveryValue}
            </span>
            <span className="text-xs text-muted-foreground">{recoveryCaption}</span>
          </div>
          <CalibrationBar scored={scored} maturing={pending} tone="emerald" />
        </div>

        <div className="space-y-2.5 sm:border-l sm:border-border/50 sm:pl-6">
          <Kicker>Duration calls</Kicker>
          <div className="flex items-baseline gap-2">
            {durationScored > 0 ? (
              <>
                <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                  {formatSignedDuration(metrics.meanSignedDurationErrorSec)}
                </span>
                <span className="text-xs text-muted-foreground">
                  mean miss · ±
                  {formatElapsedSeconds(metrics.meanAbsoluteDurationErrorSec ?? 0)}
                </span>
              </>
            ) : (
              <>
                <span className="font-mono text-2xl font-semibold tabular-nums text-muted-foreground/70">
                  —
                </span>
                <span className="text-xs text-muted-foreground">not yet scored</span>
              </>
            )}
          </div>
          <CalibrationBar scored={durationScored} maturing={pending} tone="cyan" />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-border/50 pt-3">
        <BreakdownStat
          label="correct"
          value={metrics.recoveryLikelihoodCorrectCount}
          tone="emerald"
        />
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
        <BreakdownStat label="pending" value={pending} />
      </div>
    </div>
  );
}

function getCoverageMetric(
  metrics: DdrrHeadlineMetrics,
  key: CoverageMetricKey,
): number | null {
  if (key === "scoreableCoveragePct") {
    const denominator = metrics.policyUniverseIncidentCount;
    return denominator > 0 ? metrics.recoveryLikelihoodScoredCount / denominator : null;
  }

  if (key === "publicationSuccessPct") {
    const published = metrics.lockedPredictionCount;
    const retryPending = metrics.publicationRetryPendingCount;
    const failed = metrics.publicationFailedCount;
    const denominator = published + retryPending + failed;
    return denominator > 0 ? published / denominator : null;
  }

  const v2Key =
    key === "predictionCoveragePct"
      ? "predictionRatePct"
      : key === "noCallSharePct"
        ? "noCallRatePct"
        : key === "invalidationRatePct"
          ? "invalidatedPct"
          : null;
  return v2Key ? metrics[v2Key] : null;
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
        <span className="font-mono text-[10px] text-muted-foreground">
          {policyUniverseCount.toLocaleString()} policy-universe incidents
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        {metricCards.map((metric) => (
          <div key={metric.label} className="min-w-0 rounded-lg border border-border/50 bg-background/40 px-3 py-2.5">
            <p className="truncate text-[11px] text-muted-foreground">{metric.label}</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{metric.value}</p>
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
  const verdictLabel = coverageState ? COVERAGE_LABELS[coverageState] : VERDICT_LABELS[verdictReview];
  const verdictStyle = coverageState ? COVERAGE_STYLES[coverageState] : VERDICT_STYLES[verdictReview];
  const durationText =
    signedDurationErrorSec == null
      ? DURATION_LABELS[durationReview]
      : `${formatSignedDuration(signedDurationErrorSec)} ${DURATION_LABELS[durationReview]}`;

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
          "justify-self-end text-[11px] sm:col-start-3 sm:row-start-1 sm:justify-self-start",
          verdictStyle,
        )}
      >
        {verdictLabel}
      </Badge>
      <span className="justify-self-start font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:col-start-2 sm:row-start-1 sm:justify-self-end sm:text-right">
        {getRowContextLabel(row)} · {OUTCOME_LABELS[actualOutcome]}
      </span>
      <span className="justify-self-end font-mono text-[11px] tabular-nums text-muted-foreground sm:col-start-4 sm:row-start-1 sm:whitespace-nowrap">
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
    <div className="hidden items-center gap-3 text-[10px] text-muted-foreground sm:flex">
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
  const scored = data?.summary.headline.recoveryLikelihoodScoredCount ?? 0;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-2.5">
          <span className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-[0.08em] text-cyan-700 dark:text-cyan-300">
            DDRR
          </span>
          <h2 className="pharos-section-title">Depeg Duration Resolver Reviewer</h2>
          <Badge
            variant="outline"
            className={cn(
              "px-1.5 py-0 text-[10px] uppercase tracking-wide",
              calibrating
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
            )}
          >
            {calibrating ? "Calibrating" : "Review"}
          </Badge>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                aria-label="About the Depeg Duration Resolver Reviewer"
                className="pharos-focus-ring inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent className="max-w-[300px]">
                Each stored DDR readout is graded against later confirmed event data. Open events stay
                pending unless terminal lifecycle evidence, such as frozen or dead status, matures the
                call.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {meta ? (
          <p className="font-mono text-[10px] text-muted-foreground">
            comparing {meta.assessedEventCount} stored readouts · {scored} scored
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
  const orderedRows = [...rows].sort((a, b) => Number(isScored(b)) - Number(isScored(a)));
  const shownRows = orderedRows.slice(0, ROW_DISPLAY_LIMIT);
  const hiddenCount = orderedRows.length - shownRows.length;
  const trackRecordRows = rows.filter(isTrackRecordRow);

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
              <div className="mt-1 flex justify-between font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
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
              <p className="px-1 font-mono text-[11px] text-muted-foreground">
                +{hiddenCount} more reviewer rows
              </p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
