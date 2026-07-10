import type { HealthResponse, StatusResponse } from "@shared/types";
import { AdminActionsPanel } from "@/components/status/admin-actions-panel";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { buildActionReadinessChecks } from "@/lib/status/admin-ops-insights";
import type { deriveStatusActionRecommendations } from "@/lib/status/action-recommendations";

export interface ActionsSectionProps {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  clientDataStale: boolean;
  handleRefresh: () => void;
  recommendedActions: ReturnType<typeof deriveStatusActionRecommendations>;
}

export function ActionsSection({
  data,
  healthData,
  clientDataStale,
  handleRefresh,
  recommendedActions,
}: ActionsSectionProps) {
  const readinessChecks = buildActionReadinessChecks({
    data,
    healthData,
    clientDataStale,
    recommendedActions,
  });
  const systemHealthy =
    data.overallStatus === "healthy" &&
    healthData?.status === "healthy" &&
    !clientDataStale &&
    recommendedActions.length === 0;

  return (
    <StatusSection
      id="actions"
      kicker="Operations"
      title="Actions"
      headingLevel="h1"
      variant="workspace"
      description="Inspect evidence, preview bounded changes, and run recovery actions with scope and readiness visible before confirmation."
      summary={
        <>
          <SummaryBadge label="Suggested" value={String(recommendedActions.length)} />
          <SummaryBadge label="Cron Errors" value={String(data.summary.cronErrors)} />
          <SummaryBadge label="Impacting Crons" value={String(data.summary.availabilityImpactingUnhealthyCrons)} />
        </>
      }
    >
      <AdminActionsPanel
        status={{ causes: data.causes, crons: data.crons }}
        nowSeconds={data.timestamp}
        readinessChecks={readinessChecks}
        systemHealthy={systemHealthy}
        recommendations={recommendedActions}
        onActionFinished={handleRefresh}
        showRecommendations
      />
    </StatusSection>
  );
}
