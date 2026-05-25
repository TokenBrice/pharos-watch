"use client";

import type {
  PublicStatusHistoryResponse,
  PublicStatusHistoryWindow,
} from "@shared/types";
import { PublicTransitionTimeline } from "@/components/status/public-transition-timeline";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";

interface PublicStatusHistorySectionProps {
  historyData: PublicStatusHistoryResponse | undefined;
  historyWindow: PublicStatusHistoryWindow;
  historyLoading: boolean;
  onHistoryWindowChange: (window: PublicStatusHistoryWindow) => void;
}

export function PublicStatusHistorySection({
  historyData,
  historyWindow,
  historyLoading,
  onHistoryWindowChange,
}: PublicStatusHistorySectionProps) {
  return (
    <StatusSection
      id="history"
      title="Status transitions"
      summary={
        (historyData?.transitions.length ?? 0) > 0 ? (
          <SummaryBadge
            label="Transitions"
            value={String(historyData?.transitions.length ?? 0)}
          />
        ) : undefined
      }
    >
      <PublicTransitionTimeline
        transitions={historyData?.transitions ?? []}
        window={historyWindow}
        onWindowChange={onHistoryWindowChange}
        isLoading={historyLoading}
      />
    </StatusSection>
  );
}
