import type { StatusResponse } from "@shared/types";
import { AdminActionsPanel } from "@/components/status/admin-actions-panel";
import { TelegramBotStats } from "@/components/status/telegram-bot-stats";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import type { AdminAccess } from "@/lib/admin-access";
import type { deriveStatusActionRecommendations } from "@/lib/status/action-recommendations";

export interface ControlSectionProps {
  data: StatusResponse;
  adminAccess: AdminAccess;
  handleRefresh: () => void;
  recommendedActions: ReturnType<typeof deriveStatusActionRecommendations>;
  isTelegramOpen: boolean;
  setIsTelegramOpen: (open: boolean) => void;
}

export function ControlSection({
  data,
  adminAccess,
  handleRefresh,
  recommendedActions,
  isTelegramOpen,
  setIsTelegramOpen,
}: ControlSectionProps) {
  return (
    <StatusSection
      id="control"
      kicker="Operations"
      title="Manual response"
      description="Rarely-used recovery actions and operator controls. Positioned last since these are only needed during active incidents."
      accentClassName="border-l-emerald-500"
      summary={
        <>
          <SummaryBadge label="Suggested Actions" value={String(recommendedActions.length)} />
          <SummaryBadge label="Alert-ready Chats" value={String(data.telegramBot?.deliverableChats ?? 0)} />
          <SummaryBadge label="Pending Deliveries" value={String(data.telegramBot?.pendingDeliveries ?? 0)} />
        </>
      }
    >
      <AdminActionsPanel
        adminAccess={adminAccess}
        status={{ causes: data.causes, crons: data.crons }}
        nowSeconds={data.timestamp}
        onActionFinished={handleRefresh}
        showRecommendations={false}
      />
      <details
        open={isTelegramOpen}
        onToggle={(event) => setIsTelegramOpen(event.currentTarget.open)}
        className="rounded-[1.25rem] border border-border/60 bg-background/30 p-4"
      >
        <summary className="cursor-pointer text-sm font-medium text-foreground">Telegram delivery telemetry</summary>
        <div className="mt-4">
          <TelegramBotStats
            telegramBot={data.telegramBot}
            dispatchCron={data.crons["dispatch-telegram-alerts"]}
            error={data.sectionErrors.telegramBot}
            nowSeconds={data.timestamp}
          />
        </div>
      </details>
    </StatusSection>
  );
}
