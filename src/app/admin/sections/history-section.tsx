import type { StatusResponse } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";
import { TransitionTimeline } from "@/components/status/transition-timeline";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { formatTimestampSeconds, formatTransitionLabel } from "@/lib/status-dashboard-model";
import type { StatusHistoryWindow } from "@/hooks/use-status-history";
import type { ReleaseMetadataState } from "@/hooks/use-release-metadata";

export interface HistorySectionProps {
  allTransitions: StatusResponse["timeline"];
  latestTransition: StatusResponse["timeline"][number] | null;
  reserveComposition: StatusResponse["reserveComposition"];
  releaseMetadataState: ReleaseMetadataState;
  nowSeconds: number;
  historyWindow: StatusHistoryWindow;
  setHistoryWindow: (window: StatusHistoryWindow) => void;
  historyLoading: boolean;
}

function getFirstDegradationAfterRelease(
  transitions: StatusResponse["timeline"],
  releaseCreatedAtSec: number | null,
): StatusResponse["timeline"][number] | null {
  if (releaseCreatedAtSec == null) return null;
  return (
    [...transitions]
      .filter((transition) => transition.transitionType === "degrade" && transition.at >= releaseCreatedAtSec)
      .sort((a, b) => a.at - b.at)[0] ?? null
  );
}

function ReleaseCorrelationPanel({
  transitions,
  releaseMetadataState,
  nowSeconds,
}: {
  transitions: StatusResponse["timeline"];
  releaseMetadataState: ReleaseMetadataState;
  nowSeconds: number;
}) {
  const release = releaseMetadataState.metadata;
  const firstDegrade = getFirstDegradationAfterRelease(transitions, release?.createdAtSec ?? null);

  if (releaseMetadataState.status === "loading") {
    return (
      <div className="rounded-xl border border-border/60 bg-background/35 p-4 text-sm text-muted-foreground">
        Loading Pages release marker...
      </div>
    );
  }

  if (!release) {
    return (
      <div className="rounded-xl border border-border/60 bg-background/35 p-4 text-sm text-muted-foreground">
        Pages release marker is unavailable in this environment. Deploy correlation needs `/__pharos_release.json`.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">Release correlation</h3>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Pages release marker compared with the currently loaded admin transition window. Worker deploy metadata is
            not exposed yet.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SummaryBadge label="Commit" value={release.commit ? release.commit.slice(0, 8) : "—"} />
          <SummaryBadge label="Run" value={release.runId ?? "—"} />
          <SummaryBadge
            label="Released"
            value={
              release.createdAtSec == null
                ? "—"
                : `${formatElapsedSeconds(Math.max(0, nowSeconds - release.createdAtSec))} ago`
            }
          />
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-border/60 bg-background/45 p-3 text-sm">
        {firstDegrade ? (
          <div>
            <span className="font-medium text-amber-700 dark:text-amber-300">First degradation after release: </span>
            <span className="font-mono tabular-nums">{formatTransitionLabel(firstDegrade)}</span>
            <span className="text-muted-foreground"> at {formatTimestampSeconds(firstDegrade.at)}</span>
          </div>
        ) : (
          <div className="text-muted-foreground">
            No degradation transition appears after this Pages release in the loaded history window.
          </div>
        )}
      </div>
    </div>
  );
}

export function HistorySection({
  allTransitions,
  latestTransition,
  reserveComposition,
  releaseMetadataState,
  nowSeconds,
  historyWindow,
  setHistoryWindow,
  historyLoading,
}: HistorySectionProps) {
  return (
    <StatusSection
      id="history"
      kicker="Incident Log"
      title="Incident History"
      accentClassName="border-l-rose-500"
      summary={
        <>
          <SummaryBadge label="Window" value={historyWindow} />
          <SummaryBadge label="Transitions" value={String(allTransitions.length)} />
          <SummaryBadge label="Latest" value={latestTransition ? formatTransitionLabel(latestTransition) : "—"} />
          <SummaryBadge label="Reserve Deferred" value={String(reserveComposition.deferredCoins)} />
          <SummaryBadge label="Write Uncertain" value={String(reserveComposition.writeTimeoutUncertain)} />
        </>
      }
    >
      <TransitionTimeline
        transitions={allTransitions}
        window={historyWindow}
        onWindowChange={setHistoryWindow}
        isLoading={historyLoading}
      />
      <ReleaseCorrelationPanel
        transitions={allTransitions}
        releaseMetadataState={releaseMetadataState}
        nowSeconds={nowSeconds}
      />
      {reserveComposition.runBudgetTruncated && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          Live reserve sync last truncated by run budget; resumes at{" "}
          {reserveComposition.nextCursorStablecoinId ?? "next configured coin"}.
        </div>
      )}
    </StatusSection>
  );
}
