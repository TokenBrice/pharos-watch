"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isDepegResolverReviewerEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatElapsedSeconds } from "@shared/lib/format";
import {
  DDRR_PUBLIC_WARNING,
  type DdrrActualOutcome,
  type DdrrCheckpoint,
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

/** Below this many scored verdicts, accuracy is presented as a raw fraction, not a percentage. */
const CALIBRATION_THRESHOLD = 5;
const ROW_DISPLAY_LIMIT = 8;

const VERDICT_LABELS: Record<DdrrVerdictReview, string> = {
  correct_recoverable: "Correct",
  correct_terminal: "Correct",
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
  orphan_closed: "closed without recovery",
  terminal_observed: "terminal observed",
  still_open: "still open",
  source_event_missing: "source missing",
  data_issue: "data issue",
};

const CHECKPOINT_LABELS: Record<DdrrCheckpoint, string> = {
  first: "First",
  age_1h: "1h",
  age_6h: "6h",
  age_24h: "24h",
  age_7d: "7d",
  latest: "Latest",
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

/** Verdict reviews that count as a real, scored result (vs. still maturing). */
const SCORED_VERDICTS = new Set<DdrrVerdictReview>([
  "correct_recoverable",
  "correct_terminal",
  "false_terminal",
  "false_recoverable",
  "risk_noted_terminal",
]);

function isScored(row: DdrrRow): boolean {
  return SCORED_VERDICTS.has(row.verdictReview);
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const pct = value * 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

function formatSignedDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "N/A";
  const rounded = Math.round(seconds);
  if (rounded === 0) return "0s";
  return `${rounded > 0 ? "+" : "−"}${formatElapsedSeconds(Math.abs(rounded))}`;
}

// --- primitives ------------------------------------------------------------

function Kicker({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </p>
  );
}

function CoinLockup({
  row,
  logos,
}: {
  row: Pick<DdrrRow, "stablecoinId" | "symbol" | "name">;
  logos?: Record<string, string>;
}) {
  return (
    <Link
      href={buildStablecoinUrl(row.stablecoinId)}
      className="pharos-focus-ring group/lockup flex min-w-0 items-center gap-2 rounded-sm"
    >
      <StablecoinLogo src={logos?.[row.stablecoinId]} name={row.symbol} size={22} />
      <span className="truncate text-sm font-semibold text-foreground group-hover/lockup:underline">
        {row.symbol}
      </span>
      <span className="truncate text-xs text-muted-foreground">{row.name}</span>
    </Link>
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

function CalibrationLedger({ summary }: { summary: DdrrSummary }) {
  const correct = summary.recoveryLikelihoodCorrectCount;
  const scored = summary.recoveryLikelihoodScoredCount;
  const pct = summary.recoveryLikelihoodAccuracyPct;
  const durationScored = summary.durationScoredCount;

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
          <CalibrationBar scored={scored} maturing={summary.pending} tone="emerald" />
        </div>

        <div className="space-y-2.5 sm:border-l sm:border-border/50 sm:pl-6">
          <Kicker>Duration calls</Kicker>
          <div className="flex items-baseline gap-2">
            {durationScored > 0 ? (
              <>
                <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                  {formatSignedDuration(summary.averageSignedDurationErrorSec)}
                </span>
                <span className="text-xs text-muted-foreground">
                  mean miss · ±{formatElapsedSeconds(summary.averageAbsoluteDurationErrorSec ?? 0)}
                </span>
              </>
            ) : (
              <>
                <span className="font-mono text-2xl font-semibold tabular-nums text-muted-foreground/60">
                  —
                </span>
                <span className="text-xs text-muted-foreground">not yet scored</span>
              </>
            )}
          </div>
          <CalibrationBar scored={durationScored} maturing={summary.pending} tone="cyan" />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-border/50 pt-3">
        <BreakdownStat
          label="correct"
          value={summary.correctRecoverable + summary.correctTerminal}
          tone="emerald"
        />
        <BreakdownStat
          label="false terminal"
          value={summary.falseTerminal}
          tone={summary.falseTerminal > 0 ? "red" : "muted"}
        />
        <BreakdownStat
          label="false recoverable"
          value={summary.falseRecoverable}
          tone={summary.falseRecoverable > 0 ? "red" : "muted"}
        />
        <BreakdownStat label="inside IQR" value={`${summary.withinIqrCount}/${summary.iqrScoredCount}`} />
        <BreakdownStat label="pending" value={summary.pending} />
      </div>
    </div>
  );
}

function ReviewRow({ row, logos }: { row: DdrrRow; logos?: Record<string, string> }) {
  const scored = isScored(row);
  const durationText =
    row.signedErrorSec == null
      ? DURATION_LABELS[row.durationReview]
      : `${formatSignedDuration(row.signedErrorSec)} ${DURATION_LABELS[row.durationReview]}`;

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
        <CoinLockup row={row} logos={logos} />
      </div>
      <Badge
        variant="outline"
        className={cn(
          "justify-self-end text-[11px] sm:col-start-3 sm:row-start-1 sm:justify-self-start",
          VERDICT_STYLES[row.verdictReview],
        )}
      >
        {VERDICT_LABELS[row.verdictReview]}
      </Badge>
      <span className="justify-self-start font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:col-start-2 sm:row-start-1 sm:justify-self-end sm:text-right">
        {CHECKPOINT_LABELS[row.checkpoint]} · {OUTCOME_LABELS[row.actualOutcome]}
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
  const scored = data?.summary?.recoveryLikelihoodScoredCount ?? 0;
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5">
      <div className="flex items-center gap-2">
        <h2 className="pharos-kicker">Depeg Duration Resolver Reviewer</h2>
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
              className="pharos-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground sm:h-5 sm:w-5"
            >
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent className="max-w-[300px]">
              Each stored DDR readout is graded against later confirmed event data once the event
              closes. Open events stay pending and are excluded from scored accuracy.
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
  const calibrating = (summary?.recoveryLikelihoodScoredCount ?? 0) < CALIBRATION_THRESHOLD;

  // Scored rows carry the signal; surface them first, then a capped run of maturing rows.
  const orderedRows = [...rows].sort((a, b) => Number(isScored(b)) - Number(isScored(a)));
  const shownRows = orderedRows.slice(0, ROW_DISPLAY_LIMIT);
  const hiddenCount = orderedRows.length - shownRows.length;

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
          <CalibrationLedger summary={summary} />
          <ReviewerNote text={data._meta.publicWarning ?? DDRR_PUBLIC_WARNING} />

          {data._meta.degraded ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              Reviewer snapshot is degraded: {data._meta.degradedReason ?? "unknown"}.
            </p>
          ) : null}

          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <Kicker>Reviewed readouts</Kicker>
              <ReviewLegend />
            </div>
            <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card/40">
              {shownRows.map((row) => (
                <ReviewRow key={`${row.eventId}:${row.checkpoint}:${row.assessedAt}`} row={row} logos={logos} />
              ))}
            </ul>
            {hiddenCount > 0 ? (
              <p className="px-1 font-mono text-[11px] text-muted-foreground">
                +{hiddenCount} more maturing
              </p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
