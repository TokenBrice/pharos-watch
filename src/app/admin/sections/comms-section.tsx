import { parseTelegramDispatchCronMetadata } from "@shared/lib/status-metadata";
import type { StatusResponse } from "@shared/types";
import { TelegramBotStats } from "@/components/status/telegram-bot-stats";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";

export interface CommsSectionProps {
  data: StatusResponse;
}

export function CommsSection({ data }: CommsSectionProps) {
  const dispatchCron = data.crons["dispatch-telegram-alerts"];
  const dispatchMeta = parseTelegramDispatchCronMetadata(dispatchCron?.lastRun?.metadata);

  return (
    <StatusSection
      id="comms"
      kicker="Messaging"
      title="Comms"
      accentClassName="border-l-teal-500"
      summary={
        <>
          <SummaryBadge label="Alert-ready Chats" value={String(data.telegramBot?.deliverableChats ?? 0)} />
          <SummaryBadge label="Pending Deliveries" value={String(data.telegramBot?.pendingDeliveries ?? 0)} />
          <SummaryBadge label="Latest Dispatch" value={dispatchCron?.lastRun?.status ?? "—"} />
          {dispatchMeta?.cappedAtLimit ? <SummaryBadge label="Dispatch Cap" value="hit" /> : null}
        </>
      }
    >
      <TelegramBotStats
        telegramBot={data.telegramBot}
        dispatchCron={dispatchCron}
        error={data.sectionErrors.telegramBot}
        nowSeconds={data.timestamp}
      />
    </StatusSection>
  );
}
