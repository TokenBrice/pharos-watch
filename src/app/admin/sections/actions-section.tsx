import type { StatusResponse } from "@shared/types";
import { AdminActionsPanel } from "@/components/status/admin-actions-panel";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import type { deriveStatusActionRecommendations } from "@/lib/status/action-recommendations";

export interface ActionsSectionProps {
  data: StatusResponse;
  handleRefresh: () => void;
  recommendedActions: ReturnType<typeof deriveStatusActionRecommendations>;
}

export function ActionsSection({
  data,
  handleRefresh,
  recommendedActions,
}: ActionsSectionProps) {
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
      <AdminActionsPanel
        status={{ causes: data.causes, crons: data.crons }}
        nowSeconds={data.timestamp}
        onActionFinished={handleRefresh}
        showRecommendations
      />
    </StatusSection>
  );
}
