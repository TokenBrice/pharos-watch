import type { StatusResponse } from "@shared/types";
import { TelegramBotStats } from "@/components/status/telegram-bot-stats";
import { TelegramBroadcastPanel } from "@/components/status/telegram-broadcast-panel";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { buildCommsWorkbenchModel, formatOldestBacklogAge } from "@/lib/comms-workbench-model";
import { formatCronRunStatus } from "@/lib/cron-workbench-model";

export interface CommsSectionProps {
  data: StatusResponse;
}

export function CommsSection({ data }: CommsSectionProps) {
  const dispatchCron = data.crons["dispatch-telegram-alerts"];
  const model = buildCommsWorkbenchModel({
    telegramBot: data.telegramBot,
    dispatchCron,
    sectionError: data.sectionErrors.telegramBot,
    nowSeconds: data.timestamp,
  });
  const healthLabel = `${model.delivery.health.charAt(0).toUpperCase()}${model.delivery.health.slice(1)}`;

  return (
    <StatusSection
      id="comms"
      kicker="Messaging"
      title="Comms"
      headingLevel="h1"
      variant="workspace"
      description="Telegram delivery operations and audience coverage."
      summary={
        <>
          <SummaryBadge label="Delivery" value={healthLabel} />
          <SummaryBadge
            label="Oldest backlog"
            value={formatOldestBacklogAge(model.delivery.oldestBacklogAgeSec, model.delivery.pendingDeliveries)}
          />
          <SummaryBadge
            label="Permanent failures"
            value={model.delivery.permanentFailures.total?.toLocaleString() ?? "Unknown"}
          />
          <SummaryBadge
            label="Latest dispatch"
            value={
              model.delivery.latestDispatch.status
                ? formatCronRunStatus(model.delivery.latestDispatch.status, dispatchCron?.runs[0])
                : "Unknown"
            }
          />
        </>
      }
    >
      <TelegramBotStats model={model} />
      <TelegramBroadcastPanel />
    </StatusSection>
  );
}
