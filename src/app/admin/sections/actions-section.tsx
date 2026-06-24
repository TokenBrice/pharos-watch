import type { HealthResponse, StatusResponse } from "@shared/types";
import { ActionReadinessPanel } from "@/components/status/action-readiness-panel";
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

  return (
    <StatusSection
      id="actions"
      kicker="Operations"
      title="Actions"
      accentClassName="border-l-emerald-500"
      summary={
        <>
          <SummaryBadge label="Suggested" value={String(recommendedActions.length)} />
          <SummaryBadge label="Cron Errors" value={String(data.summary.cronErrors)} />
          <SummaryBadge label="Impacting Crons" value={String(data.summary.availabilityImpactingUnhealthyCrons)} />
        </>
      }
    >
      <ActionReadinessPanel checks={readinessChecks} />
      <AdminActionsPanel
        status={{ causes: data.causes, crons: data.crons }}
        nowSeconds={data.timestamp}
        onActionFinished={handleRefresh}
        showRecommendations
      />
    </StatusSection>
  );
}
