import type { StatusResponse } from "@shared/types";
import { TransitionTimeline } from "@/components/status/transition-timeline";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { formatTransitionLabel } from "@/lib/status-dashboard-model";
import type { StatusHistoryWindow } from "@/hooks/use-status-history";

export interface HistorySectionProps {
  allTransitions: StatusResponse["timeline"];
  latestTransition: StatusResponse["timeline"][number] | null;
  historyWindow: StatusHistoryWindow;
  setHistoryWindow: (window: StatusHistoryWindow) => void;
  historyLoading: boolean;
}

export function HistorySection({
  allTransitions,
  latestTransition,
  historyWindow,
  setHistoryWindow,
  historyLoading,
}: HistorySectionProps) {
  return (
    <StatusSection
      id="history"
      kicker="Incident Log"
      title="Timeline and recovery trail"
      description="Historical context stays last so the page tapers from action into evidence."
      accentClassName="border-l-rose-500"
      summary={
        <>
          <SummaryBadge label="Window" value={historyWindow} />
          <SummaryBadge label="Transitions" value={String(allTransitions.length)} />
          <SummaryBadge label="Latest" value={latestTransition ? formatTransitionLabel(latestTransition) : "—"} />
        </>
      }
    >
      <TransitionTimeline
        transitions={allTransitions}
        window={historyWindow}
        onWindowChange={setHistoryWindow}
        isLoading={historyLoading}
      />
    </StatusSection>
  );
}
