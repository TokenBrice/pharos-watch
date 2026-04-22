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
      accentClassName="border-l-slate-400 dark:border-l-slate-600 bg-[linear-gradient(180deg,oklch(0.99_0.002_248_/_0.98),oklch(0.968_0.006_248_/_0.98)_46%,oklch(0.952_0.008_248_/_0.99))] shadow-[0_18px_40px_oklch(0_0_0_/0.08)] dark:bg-[linear-gradient(180deg,rgba(14,16,22,0.42),rgba(7,10,18,0.94))] dark:shadow-[0_18px_40px_oklch(0_0_0_/0.14)]"
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
