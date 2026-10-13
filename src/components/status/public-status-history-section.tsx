"use client";

import type { PublicStatusHistoryResponse } from "@shared/types";
import { PublicIncidentList } from "@/components/status/public-transition-timeline";
import { StatusSection } from "@/components/status/page-primitives";

interface PublicStatusHistorySectionProps {
  historyData: PublicStatusHistoryResponse | undefined;
  historyDays: number;
  historyLoading: boolean;
  historyError: Error | null;
  liveOperational: boolean;
}

export function PublicStatusHistorySection({
  historyData,
  historyDays,
  historyLoading,
  historyError,
  liveOperational,
}: PublicStatusHistorySectionProps) {
  return (
    <StatusSection id="history" title="Incidents" description={`Last ${historyDays} days, from the public component log.`}>
      {historyError ? (
        // A failed read is not an empty incident log, even with retained data (R2).
        <p className="text-sm text-muted-foreground">Incident history could not be loaded: {historyError.message}</p>
      ) : historyData ? (
        <PublicIncidentList
          transitions={historyData.transitions}
          nowSec={historyData.timestamp}
          historyDays={historyDays}
          hasMore={historyData.hasMore === true}
          liveOperational={liveOperational}
          publicHistoryStartedAt={historyData.publicHistoryStartedAt ?? null}
        />
      ) : historyLoading ? (
        <p className="text-sm text-muted-foreground">Loading incident history</p>
      ) : (
        <p className="text-sm text-muted-foreground">Incident history could not be loaded.</p>
      )}
    </StatusSection>
  );
}
