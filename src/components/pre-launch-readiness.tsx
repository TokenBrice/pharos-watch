"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DRIFT_STATUS_LABEL, PHASE_DOT, formatFuzzyDate, type DriftDisplayStatus } from "@/lib/pre-launch";
import {
  computeLaunchClock,
  describeLaunchWindow,
  formatPhaseLabel,
  parseFuzzyRange,
  resolveTargetlessDrift,
} from "@/lib/pre-launch-dossier";
import { formatUtcDayLabel } from "@shared/lib/format";
import type { StablecoinMeta } from "@shared/types";

const DAY_MS = 86_400_000;
const clockListeners = new Set<() => void>();
let clockNowMs: number | null = null;
let clockTimer: number | undefined;

function updateClock() {
  window.clearTimeout(clockTimer);
  clockNowMs = Date.now();
  // Every fuzzy target expires at a UTC midnight, as do announcement day counts.
  // Waking daily also advances the path after its last target has expired.
  const nextDayMs = (Math.floor(clockNowMs / DAY_MS) + 1) * DAY_MS;
  clockTimer = window.setTimeout(updateClock, nextDayMs - clockNowMs);
  for (const listener of clockListeners) listener();
}

function resumeClock() {
  if (document.visibilityState === "visible") updateClock();
}

function subscribeToClock(listener: () => void) {
  clockListeners.add(listener);
  if (clockListeners.size === 1) {
    document.addEventListener("visibilitychange", resumeClock);
    updateClock();
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) {
      window.clearTimeout(clockTimer);
      document.removeEventListener("visibilitychange", resumeClock);
      clockNowMs = null;
    }
  };
}

const getClockSnapshot = () => clockNowMs;
const getServerClockSnapshot = () => null;

/**
 * One visitor-clock snapshot and UTC-boundary timer for readiness and path.
 * Server and first hydration retain placeholders, never the build date.
 */
export function usePreLaunchNowMs(): number | null {
  return useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
}

/**
 * Drift tone follows the drift badges: a push is amber, red is reserved for
 * overdue. A retired target with none set is neutral: Pharos retired it in
 * curation, which says nothing about the issuer.
 */
const DRIFT_TONE: Record<DriftDisplayStatus, string> = {
  "on-track": "text-foreground",
  "pushed-once": "text-state-warn-strong",
  "pushed-multiple": "text-state-warn-strong",
  "no-current-target": "text-muted-foreground",
  overdue: "text-state-danger-strong",
};

const FIGURE_CLASS = "pharos-numeric text-[2rem] font-semibold leading-none tracking-tight";
const WORD_CLASS = "text-2xl font-semibold leading-none tracking-tight";
const PLACEHOLDER = <span className="text-muted-foreground">–</span>;

/** The live hero's `CompactMetricCell` grammar: label, headline, one sub-line. */
function ReadinessCell({ label, children, sub }: { label: string; children: ReactNode; sub: ReactNode }) {
  return (
    // 2×2 below `lg` (this pipeline emits no `max-*` variants), one row of four from `lg`.
    <div className="min-w-0 border-border/40 px-4 py-4 odd:border-r sm:px-6 sm:py-5 [&:nth-child(-n+2)]:border-b lg:border-r lg:last:border-r-0 lg:[&:nth-child(-n+2)]:border-b-0">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <div className="mt-3 flex min-h-8 items-center">{children}</div>
      <p className="pharos-label mt-2 min-h-4 text-pretty">{sub}</p>
    </div>
  );
}

/**
 * The launch-readiness answer: phase, target, drift and age. Registry facts
 * render on the server; the window countdown, overdue check and day count
 * wait for the browser clock.
 */
export function PreLaunchReadiness({
  coin,
}: {
  coin: Pick<StablecoinMeta, "launchPhase" | "announcedDate" | "expectedLaunchDate" | "dateHistory">;
}) {
  const nowMs = usePreLaunchNowMs();
  const clock = nowMs == null ? null : computeLaunchClock(coin, nowMs);
  const target = coin.expectedLaunchDate ? parseFuzzyRange(coin.expectedLaunchDate) : null;
  const moves = coin.dateHistory?.length ?? 0;
  const lastMove = moves > 0 ? [...coin.dateHistory!].sort((a, b) => b.setOn.localeCompare(a.setOn))[0] : null;
  const lastMoveDay = lastMove ? formatUtcDayLabel(new Date(`${lastMove.setOn}T00:00:00Z`)) : null;
  // A retired target with no current one reads no clock, so it renders on the server too.
  const drift = coin.expectedLaunchDate ? (clock?.drift ?? null) : resolveTargetlessDrift(coin);
  const retiredOnly = drift === "no-current-target";

  return (
    <div role="group" aria-label="Launch readiness" className="grid grid-cols-2 lg:grid-cols-4">
      <ReadinessCell
        label="Phase"
        sub={coin.launchPhase ? "Current launch phase" : "No phase published"}
      >
        <span className={cn(WORD_CLASS, "inline-flex items-center gap-2", !coin.launchPhase && "text-muted-foreground")}>
          {coin.launchPhase ? (
            <span aria-hidden="true" className={cn("h-2.5 w-2.5 shrink-0 rounded-full", PHASE_DOT[coin.launchPhase])} />
          ) : null}
          {formatPhaseLabel(coin)}
        </span>
      </ReadinessCell>
      <ReadinessCell
        label="Target launch"
        sub={
          !coin.expectedLaunchDate
            ? retiredOnly
              ? "Earlier target retired"
              : "Not yet committed"
            : clock
              ? describeLaunchWindow(clock, target?.precision ?? null)
              : null
        }
      >
        {coin.expectedLaunchDate ? (
          <span className={FIGURE_CLASS}>{formatFuzzyDate(coin.expectedLaunchDate)}</span>
        ) : (
          <span className={cn(WORD_CLASS, "text-muted-foreground")}>No target date</span>
        )}
      </ReadinessCell>
      <ReadinessCell
        label="Target drift"
        sub={
          retiredOnly && lastMove
            ? `${formatFuzzyDate(lastMove.date)} target retired ${lastMoveDay}`
            : !coin.expectedLaunchDate
              ? "Nothing to drift from"
              : lastMove
                ? `Moved ${moves}× · last ${lastMoveDay}`
                : "First target, unchanged"
        }
      >
        {drift ? (
          <span className={cn(WORD_CLASS, DRIFT_TONE[drift])}>{DRIFT_STATUS_LABEL[drift]}</span>
        ) : (
          PLACEHOLDER
        )}
      </ReadinessCell>
      <ReadinessCell
        label="Since announcement"
        sub={coin.announcedDate ? `Announced ${formatFuzzyDate(coin.announcedDate)}` : "Announcement date not recorded"}
      >
        {clock?.daysSinceAnnounced != null ? (
          <span className={FIGURE_CLASS}>
            {clock.announcedIsApproximate ? "~" : ""}
            {clock.daysSinceAnnounced.toLocaleString("en-US")}
            <span className="ml-1 text-base text-muted-foreground">d</span>
          </span>
        ) : (
          PLACEHOLDER
        )}
      </ReadinessCell>
    </div>
  );
}
