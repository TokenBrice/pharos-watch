"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
  type DdrrVerdictReview,
} from "@shared/types/depeg-resolver-review";

interface DepegResolverReviewerModuleProps {
  data: DdrrResponse | undefined;
  error?: Error | null;
  logos?: Record<string, string>;
}

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
  recovered: "Recovered",
  orphan_closed: "Closed without recovery",
  terminal_observed: "Terminal observed",
  still_open: "Still open",
  source_event_missing: "Source missing",
  data_issue: "Data issue",
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
  duration_unscored: "duration unscored",
  data_issue: "data issue",
};

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const pct = value * 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

function formatSignedDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "N/A";
  const rounded = Math.round(seconds);
  if (rounded === 0) return "0s";
  return `${rounded > 0 ? "+" : "-"}${formatElapsedSeconds(Math.abs(rounded))}`;
}

function formatDurationOrNa(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "N/A";
  return formatElapsedSeconds(Math.round(seconds));
}

function durationDirection(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "No scored recoveries yet";
  if (seconds > 0) return "observed slower than DDR median";
  if (seconds < 0) return "observed faster than DDR median";
  return "observed matched DDR median";
}

function StatBlock({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "emerald" | "cyan";
}) {
  return (
    <Card className={cn(
      "rounded-xl border-l-[3px]",
      tone === "emerald" ? "border-l-emerald-500" : "border-l-cyan-500",
    )}>
      <CardHeader className="pb-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
      </CardHeader>
      <CardContent>
        <div className="font-mono text-3xl font-semibold tabular-nums text-foreground">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function ReviewerHeader() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <h2 className="pharos-kicker">Depeg Duration Resolver Reviewer</h2>
        <Badge
          variant="outline"
          className="border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0 text-[10px] uppercase tracking-wide text-cyan-700 dark:text-cyan-400"
        >
          Review
        </Badge>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              aria-label="About the Depeg Duration Resolver Reviewer"
              className="pharos-focus-ring inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
            >
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent className="max-w-[300px]">
              Compares stored DDR assessments with later confirmed event outcomes. Pending rows are
              visible but excluded from scored accuracy.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

function ReviewRow({ row, logos }: { row: DdrrRow; logos?: Record<string, string> }) {
  const signedError = formatSignedDuration(row.signedErrorSec);
  const durationText =
    row.signedErrorSec == null
      ? DURATION_LABELS[row.durationReview]
      : `${signedError} ${DURATION_LABELS[row.durationReview]}`;

  return (
    <div className="grid gap-3 rounded-lg border border-border/60 bg-background/50 px-3 py-3 text-sm md:grid-cols-[minmax(0,1.4fr)_auto_auto_auto] md:items-center">
      <Link
        href={buildStablecoinUrl(row.stablecoinId)}
        className="pharos-focus-ring flex min-w-0 items-center gap-2 rounded-sm"
      >
        <StablecoinLogo src={logos?.[row.stablecoinId]} name={row.symbol} size={22} />
        <span className="truncate font-semibold">{row.symbol}</span>
        <span className="truncate text-xs text-muted-foreground">{row.name}</span>
      </Link>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="border-border bg-muted text-[10px] text-muted-foreground">
          {CHECKPOINT_LABELS[row.checkpoint]}
        </Badge>
        <span className="text-xs text-muted-foreground">{OUTCOME_LABELS[row.actualOutcome]}</span>
      </div>
      <Badge variant="outline" className={cn("justify-self-start text-xs md:justify-self-auto", VERDICT_STYLES[row.verdictReview])}>
        {VERDICT_LABELS[row.verdictReview]}
      </Badge>
      <div className="font-mono text-xs tabular-nums text-muted-foreground md:text-right">{durationText}</div>
    </div>
  );
}

export function DepegResolverReviewerModule({ data, error, logos }: DepegResolverReviewerModuleProps) {
  if (!isDepegResolverReviewerEnabled()) return null;

  if (error && !data) {
    return (
      <section aria-label="Depeg Duration Resolver Reviewer" className="space-y-4">
        <ReviewerHeader />
        <p className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {DDRR_PUBLIC_WARNING}
        </p>
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Reviewer data is temporarily unavailable.
          </CardContent>
        </Card>
      </section>
    );
  }

  const summary = data?.summary;
  const rows = data?.rows ?? [];
  const recentRows = rows.slice(0, 6);
  const showRows = data && recentRows.length > 0;
  const likelihoodDetail = summary
    ? `${summary.recoveryLikelihoodCorrectCount}/${summary.recoveryLikelihoodScoredCount} scored DDR recovery verdicts`
    : "Loading scored DDR recovery verdicts";
  const durationDetail = summary
    ? `${durationDirection(summary.averageSignedDurationErrorSec)}; mean absolute miss ${formatDurationOrNa(summary.averageAbsoluteDurationErrorSec)}`
    : "Loading observed-minus-predicted recovery timing";

  return (
    <section aria-label="Depeg Duration Resolver Reviewer" className="space-y-4">
      <ReviewerHeader />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <StatBlock
          label="Recovery likelihood"
          value={formatPercent(summary?.recoveryLikelihoodAccuracyPct ?? null)}
          detail={likelihoodDetail}
          tone="emerald"
        />
        <StatBlock
          label="Recovery duration"
          value={formatSignedDuration(summary?.averageSignedDurationErrorSec ?? null)}
          detail={durationDetail}
          tone="cyan"
        />
      </div>

      <p className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {data?._meta.publicWarning ?? DDRR_PUBLIC_WARNING}
      </p>

      {!data ? (
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Reviewer data is loading.
          </CardContent>
        </Card>
      ) : data._meta.degraded && rows.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Reviewer data is temporarily unavailable.
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No DDR assessments have matured into reviewable outcomes yet.
          </CardContent>
        </Card>
      ) : (
        <>
          {data._meta.degraded ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              Reviewer snapshot is degraded: {data._meta.degradedReason ?? "unknown"}.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <div className="font-mono text-lg font-semibold tabular-nums">{summary?.pending ?? 0}</div>
              <div className="text-xs text-muted-foreground">pending rows</div>
            </div>
            <div>
              <div className="font-mono text-lg font-semibold tabular-nums">{summary?.withinIqrCount ?? 0}/{summary?.iqrScoredCount ?? 0}</div>
              <div className="text-xs text-muted-foreground">inside IQR</div>
            </div>
            <div>
              <div className="font-mono text-lg font-semibold tabular-nums">{summary?.falseTerminal ?? 0}</div>
              <div className="text-xs text-muted-foreground">false terminal</div>
            </div>
            <div>
              <div className="font-mono text-lg font-semibold tabular-nums">{summary?.falseRecoverable ?? 0}</div>
              <div className="text-xs text-muted-foreground">false recoverable</div>
            </div>
          </div>
          {showRows ? (
            <div className="space-y-2">
              {recentRows.map((row) => (
                <ReviewRow key={`${row.eventId}:${row.checkpoint}:${row.assessedAt}`} row={row} logos={logos} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
