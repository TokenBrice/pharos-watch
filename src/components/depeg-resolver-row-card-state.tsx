"use client";

import { cn } from "@/lib/utils";
import {
  formatUtcTimestamp,
  getLatestErratum,
  getMissingReasons,
  type DdrCompatRow,
  type DdrDisplayRow,
  type DdrPublicPredictionState,
} from "@/components/depeg-resolver-row-card-model";
import { CoinLockup, LiveFacts, LockMetadataStrip, StageLabel } from "@/components/depeg-resolver-row-card-shared";

const STATE_COPY: Record<
  Exclude<DdrPublicPredictionState, "frozen">,
  { badge: string; title: string; body: string; tone: string }
> = {
  pending_lock: {
    badge: "Pending lock",
    title: "Prediction lock pending",
    body: "This incident has not reached forecast readiness or the 72h backstop. DDR shows live facts only until the official lock run.",
    tone: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  },
  lock_deferred: {
    badge: "Lock deferred",
    title: "Health deferral",
    body: "The lock point has arrived, but a system-health predicate failed. DDR will retry on the next healthy run.",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  publication_retry_pending: {
    badge: "Publication delayed",
    title: "Forecast publication delayed",
    body: "A sealed outcome exists operationally but has not entered the first-publication manifest. DDR hides the sealed verdict until publication succeeds.",
    tone: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
  },
  publication_failed: {
    badge: "Publication failed",
    title: "Publication failed before public exposure",
    body: "DDR did not recoverably publish this lock outcome. DDRR counts it as operational coverage debt, not as a prediction users saw.",
    tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  no_call: {
    badge: "No-call locked",
    title: "No-call at lock",
    body: "At the official lock run, required row-level inputs were missing. This is an accountable no-call, not a recovery or terminal verdict.",
    tone: "border-border bg-muted/70 text-foreground",
  },
  invalidated: {
    badge: "Invalidated",
    title: "Prediction invalidated by erratum",
    body: "The first-published lock outcome remains visible for audit, but an append-only erratum invalidated the source event or input.",
    tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  },
};

export function StateOnlyCard({
  row,
  state,
  logos,
}: {
  row: DdrDisplayRow;
  state: Exclude<DdrPublicPredictionState, "frozen">;
  logos?: Record<string, string>;
}) {
  const copy = STATE_COPY[state];
  const compat = row as DdrCompatRow;
  const retryText =
    compat.prediction?.nextRetryAt != null
      ? `Next retry ${formatUtcTimestamp(compat.prediction.nextRetryAt)}`
      : (compat.prediction?.retryStatus ?? null);
  const deferralReason = compat.prediction?.deferralReason ?? compat.live?.degradedReason ?? null;
  const missingReasons = getMissingReasons(row);
  const erratum = getLatestErratum(row);
  const originalOutcome = compat.prediction?.originalOutcomeKind ?? compat.prediction?.outcomeKind ?? null;
  const dirGlyph = row.direction === "below" ? "▼" : "▲";

  return (
    <div className="pharos-card-shell gap-0 overflow-hidden p-4 sm:p-5">
      <div className="space-y-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <CoinLockup row={row} logos={logos} logoSize={52} />
          </div>
          <span className="shrink-0 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {dirGlyph} {row.direction} {row.pegCurrency}
          </span>
        </div>

        <div className={cn("rounded-lg border px-3 py-2.5", copy.tone)}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-bold uppercase leading-none tracking-wide">{copy.title}</p>
            <span className="rounded-full border border-current/30 px-1.5 py-0.5 font-mono text-xs uppercase tracking-wide">
              {copy.badge}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-snug opacity-85">{copy.body}</p>
        </div>

        <LockMetadataStrip row={row} />
        <LiveFacts row={row} />

        {state === "lock_deferred" && (deferralReason || retryText) ? (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-xs">
            {deferralReason ? <p className="text-foreground">Deferral reason: {deferralReason}</p> : null}
            {retryText ? <p className="mt-1 text-muted-foreground">{retryText}</p> : null}
          </div>
        ) : null}

        {state === "publication_retry_pending" && retryText ? (
          <p className="rounded-lg border border-violet-500/25 bg-violet-500/[0.06] px-3 py-2.5 text-xs text-muted-foreground">
            {retryText}
          </p>
        ) : null}

        {state === "no_call" ? (
          <div className="space-y-1.5">
            <StageLabel>Missing inputs</StageLabel>
            {missingReasons.length ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {missingReasons.map((reason) => (
                  <li key={reason} className="flex gap-2">
                    <span aria-hidden="true" className="text-muted-foreground/50">
                      -
                    </span>
                    <span className="min-w-0">{reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No missing-input detail was published for this no-call.</p>
            )}
          </div>
        ) : null}

        {state === "invalidated" ? (
          <details className="group rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
            <summary className="pharos-focus-ring cursor-pointer list-none text-xs font-medium text-foreground">
              Erratum and original outcome
              <span aria-hidden="true" className="ml-1 inline-block transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>
            <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">
              <p>
                Original lock outcome:{" "}
                <span className="font-mono uppercase text-foreground">{originalOutcome ?? "published prediction"}</span>
              </p>
              <p>
                Latest erratum:{" "}
                <span className="text-foreground">
                  {erratum?.summary ??
                    erratum?.reason ??
                    compat.prediction?.invalidationReason ??
                    "details unavailable"}
                </span>
              </p>
              {erratum?.createdAt ? <p>Recorded {formatUtcTimestamp(erratum.createdAt)}.</p> : null}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
