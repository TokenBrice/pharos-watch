import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StatusResponse } from "@shared/types";
import { formatAge } from "./format";

interface TelegramBotStatsProps {
  telegramBot: StatusResponse["telegramBot"];
  dispatchCron?: StatusResponse["crons"][string];
  nowSeconds: number;
}

interface DispatchMetadata {
  subscribersNotified: number | null;
  messagesSent: number | null;
  blockedUsersCleanedUp: number | null;
  cappedAtLimit: boolean;
  snapshotSeeded: boolean;
  skipped: string | null;
  eventsDetected: {
    dews: number | null;
    depeg: number | null;
    safety: number | null;
  } | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

function parseDispatchMetadata(value: unknown): DispatchMetadata | null {
  const record = asRecord(value);
  if (!record) return null;

  const eventsRecord = asRecord(record.eventsDetected);
  return {
    subscribersNotified: readNumber(record.subscribersNotified),
    messagesSent: readNumber(record.messagesSent),
    blockedUsersCleanedUp: readNumber(record.blockedUsersCleanedUp),
    cappedAtLimit: record.cappedAtLimit === true,
    snapshotSeeded: record.snapshotSeeded === true,
    skipped: typeof record.skipped === "string" ? record.skipped : null,
    eventsDetected: eventsRecord
      ? {
          dews: readNumber(eventsRecord.dews),
          depeg: readNumber(eventsRecord.depeg),
          safety: readNumber(eventsRecord.safety),
        }
      : null,
  };
}

function renderDelta(label: string, value: number | null) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{value ?? "—"}</span>
    </div>
  );
}

export function TelegramBotStats({ telegramBot, dispatchCron, nowSeconds }: TelegramBotStatsProps) {
  if (!telegramBot) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Telegram bot metrics are unavailable. This usually means the Telegram tables have not been migrated in the
          current environment yet.
        </CardContent>
      </Card>
    );
  }

  const lastDispatch = dispatchCron?.lastRun ?? null;
  const dispatchMeta = parseDispatchMetadata(lastDispatch?.metadata);
  const dispatchStatusClass = !lastDispatch
    ? "bg-muted text-muted-foreground"
    : lastDispatch.status === "ok"
      ? "bg-green-500/15 text-green-700 dark:text-green-400"
      : lastDispatch.status === "degraded"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-red-500/15 text-red-700 dark:text-red-400";

  const summaryCards = [
    {
      label: "Subscribers",
      value: telegramBot.totalChats,
      detail: `${telegramBot.alertEnabledChats} with alert flags enabled`,
    },
    {
      label: "Alert-Ready Chats",
      value: telegramBot.deliverableChats,
      detail: `${telegramBot.subscribedChats} chats currently have tracked coins`,
    },
    {
      label: "Coin Follows",
      value: telegramBot.totalSubscriptions,
      detail: `avg ${formatMetric(telegramBot.avgSubscriptionsPerSubscribedChat)} per subscribed chat`,
    },
    {
      label: "Pending Replies",
      value: telegramBot.pendingDisambiguations,
      detail:
        telegramBot.lastSubscriberActivityAt != null
          ? `last activity ${formatAge(Math.max(0, nowSeconds - telegramBot.lastSubscriberActivityAt))} ago`
          : "no bot activity yet",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map((card) => (
          <Card key={card.label}>
            <CardContent className="pt-4">
              <div className="text-xs text-muted-foreground">{card.label}</div>
              <div className="font-mono text-2xl font-extrabold tabular-nums text-foreground">{card.value}</div>
              <div className="text-xs text-muted-foreground">{card.detail}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Alert Coverage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {renderDelta("DEWS enabled", telegramBot.alertTypeChats.dews)}
            {renderDelta("Depeg enabled", telegramBot.alertTypeChats.depeg)}
            {renderDelta("Safety enabled", telegramBot.alertTypeChats.safety)}
            {renderDelta("All 3 alert types", telegramBot.alertTypeChats.allTypes)}
            <div className="border-t pt-3">
              {renderDelta("Flags on, no coins", telegramBot.emptyAlertChats)}
              {renderDelta("Muted with saved coins", telegramBot.mutedChatsWithSubscriptions)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Last Dispatch</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {lastDispatch ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge className={dispatchStatusClass}>{lastDispatch.status}</Badge>
                  <span className="text-muted-foreground">
                    {formatAge(Math.max(0, nowSeconds - lastDispatch.startedAt))} ago
                  </span>
                  <span className="text-muted-foreground">{lastDispatch.itemCount ?? 0} messages counted</span>
                </div>
                {dispatchMeta?.skipped ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                    Run skipped: {dispatchMeta.skipped}
                  </div>
                ) : null}
                {renderDelta("Subscribers notified", dispatchMeta?.subscribersNotified ?? null)}
                {renderDelta("Messages sent", dispatchMeta?.messagesSent ?? lastDispatch.itemCount ?? null)}
                {renderDelta("Blocked cleaned up", dispatchMeta?.blockedUsersCleanedUp ?? null)}
                {renderDelta("DEWS changes", dispatchMeta?.eventsDetected?.dews ?? null)}
                {renderDelta("Depeg changes", dispatchMeta?.eventsDetected?.depeg ?? null)}
                {renderDelta("Safety changes", dispatchMeta?.eventsDetected?.safety ?? null)}
                <div className="flex flex-wrap gap-2 pt-1">
                  {dispatchMeta?.snapshotSeeded ? <Badge variant="secondary">snapshot reseeded</Badge> : null}
                  {dispatchMeta?.cappedAtLimit ? <Badge variant="secondary">hit 50-message cap</Badge> : null}
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">No dispatch runs recorded yet.</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top Subscribed Coins</CardTitle>
          </CardHeader>
          <CardContent>
            {telegramBot.topStablecoins.length > 0 ? (
              <div className="space-y-3">
                {telegramBot.topStablecoins.map((coin) => (
                  <div key={coin.stablecoinId} className="flex items-center justify-between gap-4 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">{coin.symbol}</div>
                      <div className="truncate text-xs text-muted-foreground">{coin.stablecoinId}</div>
                    </div>
                    <Badge variant="secondary" className="font-mono tabular-nums">
                      {coin.subscribers}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No coin subscriptions yet.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
