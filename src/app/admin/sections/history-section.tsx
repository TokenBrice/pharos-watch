import type { StatusResponse } from "@shared/types";
import { TransitionTimeline } from "@/components/status/transition-timeline";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { formatTransitionLabel } from "@/lib/status-dashboard-model";
import type { StatusHistoryWindow } from "@/hooks/use-status-history";

export interface HistorySectionProps {
  allTransitions: StatusResponse["timeline"];
  latestTransition: StatusResponse["timeline"][number] | null;
  reserveComposition: StatusResponse["reserveComposition"];
  historyWindow: StatusHistoryWindow;
  setHistoryWindow: (window: StatusHistoryWindow) => void;
  historyLoading: boolean;
}

export function HistorySection({
  allTransitions,
  latestTransition,
  reserveComposition,
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
      {reserveComposition.runBudgetTruncated && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          Live reserve sync last truncated by run budget; resumes at {reserveComposition.nextCursorStablecoinId ?? "next configured coin"}.
        </div>
      )}
    </StatusSection>
  );
}
