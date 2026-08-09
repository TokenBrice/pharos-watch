import { formatElapsedSeconds } from "@shared/lib/format";
import type { StatusResponse } from "@shared/types";
import { TelegramBotStats } from "@/components/status/telegram-bot-stats";
import { TelegramBroadcastPanel } from "@/components/status/telegram-broadcast-panel";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { buildCommsWorkbenchModel } from "@/lib/comms-workbench-model";

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
      description="Telegram delivery operations and audience coverage, with missing evidence kept explicitly Unknown."
      summary={
        <>
          <SummaryBadge label="Delivery" value={healthLabel} />
          <SummaryBadge
            label="Oldest Backlog"
            value={
              model.delivery.oldestBacklogAgeSec == null
                ? "Unknown"
                : formatElapsedSeconds(model.delivery.oldestBacklogAgeSec)
            }
          />
          <SummaryBadge
            label="Permanent Failures"
            value={model.delivery.permanentFailures.total?.toLocaleString() ?? "Unknown"}
          />
          <SummaryBadge
            label="Latest Dispatch"
            value={model.delivery.latestDispatch.status?.replaceAll("_", " ") ?? "Unknown"}
          />
        </>
      }
    >
      <TelegramBotStats model={model} />
      <TelegramBroadcastPanel />
    </StatusSection>
  );
}
