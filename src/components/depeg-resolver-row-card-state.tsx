"use client";

import { cn } from "@/lib/utils";
import { formatDdrDirection, formatDdrReason, getMissingReasons } from "@/components/depeg-resolver-row-card-model";
import type { DdrPublicPredictionState, DdrV2ResponseRow } from "@shared/types/depeg-resolver";
import { CoinLockup, LiveFacts, LockMetadataStrip, StageLabel } from "@/components/depeg-resolver-row-card-shared";
import { DDR_REVIEW_TONE_CLASSES } from "@shared/lib/classification";

const STATE_COPY: Record<
  Exclude<DdrPublicPredictionState, "frozen">,
  { badge: string; title: string; body: string; tone: string }
> = {
  pending_lock: {
    badge: "Pending lock",
    title: "Prediction lock pending",
    body: "This incident has not reached forecast readiness or the 72h backstop. DDR shows live facts only until the official lock run.",
    tone: "border-state-info bg-state-info-subtle text-state-info",
  },
  lock_deferred: {
    badge: "Lock deferred",
    title: "Health deferral",
    body: "The lock point has arrived, but a system-health predicate failed. DDR will retry on the next healthy run.",
    tone: "border-state-warn bg-state-warn-subtle text-state-warn",
  },
  publication_retry_pending: {
    badge: "Publication delayed",
    title: "Forecast publication delayed",
    body: "A sealed outcome exists operationally but has not entered the first-publication manifest. DDR hides the sealed verdict until publication succeeds.",
    tone: DDR_REVIEW_TONE_CLASSES.retry,
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
    tone: "border-state-danger bg-state-danger-subtle text-state-danger",
  },
};

export function StateOnlyCard({
  row,
  state,
  logos,
}: {
  row: DdrV2ResponseRow;
  state: Exclude<DdrPublicPredictionState, "frozen">;
  logos?: Record<string, string>;
}) {
  const copy = STATE_COPY[state];
  const deferralReason = row.prediction.deferralReason ?? row.live.degradedReason;
  const missingReasons = getMissingReasons(row);
  const originalOutcome =
    row.kind === "invalidated_prediction" && row.originalKind === "no_call" ? "no-call" : "published prediction";

  return (
    <div className="pharos-card-shell gap-0 overflow-hidden p-4 sm:p-5">
      <div className="space-y-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <CoinLockup row={row} logos={logos} logoSize={52} />
          </div>
          <span className="shrink-0 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground">
            {formatDdrDirection(row)}
          </span>
        </div>

        <div className={cn("rounded-lg border px-3 py-2.5", copy.tone)}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-bold leading-none">{copy.title}</p>
            <span className="rounded-full border border-current/30 px-1.5 py-0.5 text-xs font-medium">
              {copy.badge}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-snug opacity-85">{copy.body}</p>
        </div>

        <LockMetadataStrip row={row} />
        <LiveFacts row={row} />

        {state === "lock_deferred" && deferralReason ? (
          <div className="rounded-lg border border-state-warn-solid/25 bg-state-warn-solid/[0.06] px-3 py-2.5 text-xs">
            <p className="text-foreground" title={deferralReason}>
              Deferral reason: {formatDdrReason(deferralReason)}
            </p>
          </div>
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
                <span className="text-foreground">{originalOutcome}</span>
              </p>
              <p>
                Latest erratum: <span className="text-foreground">details unavailable</span>
              </p>
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
