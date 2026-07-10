import { formatElapsedSeconds } from "@shared/lib/format";
import type { StatusResponse } from "@shared/types";
import { OperationalActivity, type OperationalActivityProps } from "@/components/status/operational-activity";
import { TransitionTimeline } from "@/components/status/transition-timeline";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import type { ReleaseMetadataState } from "@/hooks/use-release-metadata";
import type { StatusHistoryWindow } from "@/hooks/use-status-history";
import {
  INCIDENT_FLAPPING_TRANSITION_THRESHOLD,
  findFirstDegradationAfter,
  type IncidentHistoryFilters,
  type WorkerVersionEvidence,
} from "@/lib/incident-history-view-model";
import { formatTimestampSeconds, formatTransitionLabel } from "@/lib/status-dashboard-model";

export interface HistorySectionProps {
  allTransitions: StatusResponse["timeline"];
  latestTransition: StatusResponse["timeline"][number] | null;
  reserveComposition: StatusResponse["reserveComposition"];
  releaseMetadataState: ReleaseMetadataState;
  workerVersionEvidence: WorkerVersionEvidence;
  adminActionLog: OperationalActivityProps["adminActions"];
  credentialAudit: OperationalActivityProps["credentialAudit"];
  nowSeconds: number;
  transitionsLast24h: number;
  historyWindow: StatusHistoryWindow;
  historyFilters: IncidentHistoryFilters;
  setHistoryWindow: (window: StatusHistoryWindow) => void;
  setHistoryFilters: (patch: Partial<IncidentHistoryFilters>) => void;
  historyLoading: boolean;
}

function PagesReleaseCorrelation({
  transitions,
  releaseMetadataState,
  nowSeconds,
}: {
  transitions: StatusResponse["timeline"];
  releaseMetadataState: ReleaseMetadataState;
  nowSeconds: number;
}) {
  const release = releaseMetadataState.metadata;
  const firstDegrade = findFirstDegradationAfter(transitions, release?.createdAtSec ?? null);

  return (
    <section aria-labelledby="pages-deployment-title" className="min-w-0 space-y-3">
      <div>
        <h4 id="pages-deployment-title" className="text-sm font-semibold text-foreground">
          Pages deployment
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">Static UI release marker from `/__pharos_release.json`.</p>
      </div>
      {releaseMetadataState.status === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading Pages release marker...</p>
      ) : !release ? (
        <div className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Pages correlation unavailable</p>
          <p>The release marker is not available in this environment.</p>
        </div>
      ) : (
        <>
          <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-muted-foreground">Commit</dt>
              <dd className="break-all font-mono text-foreground">{release.commit?.slice(0, 12) ?? "Unknown"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">Run</dt>
              <dd className="break-all font-mono text-foreground">{release.runId ?? "Unknown"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">Released</dt>
              <dd className="break-words text-foreground">
                {release.createdAtSec == null
                  ? "Unknown"
                  : `${formatElapsedSeconds(Math.max(0, nowSeconds - release.createdAtSec))} ago`}
              </dd>
            </div>
          </dl>
          <div className="border-l-2 border-border pl-3 text-sm">
            {release.createdAtSec == null ? (
              <p className="text-muted-foreground">
                Pages transition correlation is Unknown because release time is missing.
              </p>
            ) : firstDegrade ? (
              <p>
                <span className="font-medium text-amber-700 dark:text-amber-300">
                  First degradation after release:{" "}
                </span>
                <span className="font-mono text-xs tabular-nums">{formatTransitionLabel(firstDegrade)}</span>{" "}
                <span className="text-muted-foreground">at {formatTimestampSeconds(firstDegrade.at)}</span>
              </p>
            ) : (
              <p className="text-muted-foreground">
                No degradation transition appears after this Pages release in the loaded history window.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function WorkerReleaseCorrelation({ evidence }: { evidence: WorkerVersionEvidence }) {
  return (
    <section
      aria-labelledby="worker-deployment-title"
      className="min-w-0 space-y-3 border-t border-border/60 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0"
    >
      <div>
        <h4 id="worker-deployment-title" className="text-sm font-semibold text-foreground">
          Worker deployment
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">Worker deployment correlation remains Unknown.</p>
      </div>
      {evidence.status === "unavailable" ? (
        <div className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Runtime observation unavailable</p>
          <p>No Worker version observation exists in producer-head or latest-attempt payload fields.</p>
          <p className="mt-1">Deploy time, deployment ID, and deploy commit are Unknown.</p>
        </div>
      ) : (
        <>
          <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-muted-foreground">Runtime observation</dt>
              <dd className="break-all font-mono text-foreground">{evidence.version}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">Observed at</dt>
              <dd className="break-words text-foreground">
                {evidence.observedAt == null ? "Unknown" : formatTimestampSeconds(evidence.observedAt)}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">Observation sources</dt>
              <dd className="font-mono tabular-nums text-foreground">{evidence.sourceCount}</dd>
            </div>
          </dl>
          <div className="border-l-2 border-amber-500/70 pl-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Deployment correlation Unknown</p>
            <p>
              Runtime observations do not provide a Worker deploy time. No transition is attributed to this version.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function ReleaseCorrelationPanel({
  transitions,
  releaseMetadataState,
  workerVersionEvidence,
  nowSeconds,
}: {
  transitions: StatusResponse["timeline"];
  releaseMetadataState: ReleaseMetadataState;
  workerVersionEvidence: WorkerVersionEvidence;
  nowSeconds: number;
}) {
  return (
    <section aria-labelledby="deployment-correlation-title" className="space-y-4 border-y border-border/60 py-4">
      <div>
        <h3 id="deployment-correlation-title" className="text-base font-semibold text-foreground">
          Deployment correlation
        </h3>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Pages has a release marker. Worker payloads currently expose runtime observations, not deployment metadata.
        </p>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <PagesReleaseCorrelation
          transitions={transitions}
          releaseMetadataState={releaseMetadataState}
          nowSeconds={nowSeconds}
        />
        <WorkerReleaseCorrelation evidence={workerVersionEvidence} />
      </div>
    </section>
  );
}

export function HistorySection({
  allTransitions,
  latestTransition,
  reserveComposition,
  releaseMetadataState,
  workerVersionEvidence,
  adminActionLog,
  credentialAudit,
  nowSeconds,
  transitionsLast24h,
  historyWindow,
  historyFilters,
  setHistoryWindow,
  setHistoryFilters,
  historyLoading,
}: HistorySectionProps) {
  const isFlapping = transitionsLast24h > INCIDENT_FLAPPING_TRANSITION_THRESHOLD;

  return (
    <StatusSection
      id="history"
      kicker="Incident Log"
      title="Incident History"
      description="Status transitions, persisted causes, resolution timing, and deployment evidence."
      accentClassName="border-l-rose-500"
      summary={
        <>
          <SummaryBadge label="Window" value={historyWindow} />
          <SummaryBadge label="Loaded" value={String(allTransitions.length)} />
          <SummaryBadge
            label="Transitions 24h"
            value={String(transitionsLast24h)}
            className={
              isFlapping ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200" : undefined
            }
          />
          <SummaryBadge
            label="Stability"
            value={isFlapping ? "Flapping" : "Stable"}
            className={
              isFlapping ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200" : undefined
            }
          />
          <SummaryBadge label="Latest" value={latestTransition ? formatTransitionLabel(latestTransition) : "Unknown"} />
        </>
      }
    >
      <TransitionTimeline
        transitions={allTransitions}
        nowSeconds={nowSeconds}
        transitionsLast24h={transitionsLast24h}
        window={historyWindow}
        filters={historyFilters}
        onWindowChange={setHistoryWindow}
        onFiltersChange={setHistoryFilters}
        isLoading={historyLoading}
      />
      <OperationalActivity adminActions={adminActionLog} credentialAudit={credentialAudit} nowSeconds={nowSeconds} />
      <ReleaseCorrelationPanel
        transitions={allTransitions}
        releaseMetadataState={releaseMetadataState}
        workerVersionEvidence={workerVersionEvidence}
        nowSeconds={nowSeconds}
      />
      {reserveComposition.runBudgetTruncated ? (
        <div className="border-l-2 border-amber-500 bg-amber-500/[0.06] px-3 py-2.5 text-xs text-amber-950 dark:text-amber-100">
          Live reserve sync last truncated by run budget; resumes at{" "}
          {reserveComposition.nextCursorStablecoinId ?? "next configured coin"}.
        </div>
      ) : null}
    </StatusSection>
  );
}
