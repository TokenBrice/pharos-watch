import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { parseTelegramDispatchCronMetadata } from "@shared/lib/status-metadata";
import type { StatusResponse, StatusSectionError, TelegramAlertType } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";
import { TELEGRAM_LIFECYCLE_SNAPSHOT_REFRESH_SECONDS } from "@shared/lib/status-thresholds";

const PER_ALERT_TYPE_LABELS: Record<TelegramAlertType, string> = {
  dews: "DEWS",
  depeg: "Depeg",
  safety: "Safety",
  launch: "Launch",
};

const TELEGRAM_LIFECYCLE_SNAPSHOT_STALE_SECONDS = TELEGRAM_LIFECYCLE_SNAPSHOT_REFRESH_SECONDS * 2;

interface TelegramBotStatsProps {
  telegramBot: StatusResponse["telegramBot"];
  dispatchCron?: StatusResponse["crons"][string];
  error?: StatusSectionError;
  nowSeconds: number;
}

function renderMetric(label: string, value: string | number | null | undefined) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{value ?? "—"}</span>
    </div>
  );
}

function formatSnapshotCapturedAt(snapshotAt: number, ageSeconds: number) {
  return `${new Date(snapshotAt * 1000).toLocaleString()} (${formatElapsedSeconds(ageSeconds)} ago)`;
}

export function TelegramBotStats({ telegramBot, dispatchCron, error, nowSeconds }: TelegramBotStatsProps) {
  if (!telegramBot) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          {error
            ? `Telegram bot metrics query failed: ${error.message}`
            : "Telegram bot metrics are unavailable. This usually means the Telegram tables have not been migrated in the current environment yet."}
        </CardContent>
      </Card>
    );
  }

  const lastDispatch = dispatchCron?.lastRun ?? null;
  const dispatchMeta = parseTelegramDispatchCronMetadata(lastDispatch?.metadata);
  const dispatchStatusClass = !lastDispatch
    ? "bg-muted text-muted-foreground"
    : lastDispatch.status === "ok"
      ? "bg-green-500/15 text-green-700 dark:text-green-400"
      : lastDispatch.status === "degraded"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-red-500/15 text-red-700 dark:text-red-400";
  const pendingBacklog = telegramBot.pendingDeliveryBacklog;
  const retryErrorClasses = Object.entries(telegramBot.retryErrorClassCounts ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const telemetryQuality = telegramBot.quality;
  const lifecycleSnapshot = telegramBot.lifecycleSnapshot;
  const lifecycleSnapshotAgeSeconds = lifecycleSnapshot
    ? Math.max(0, nowSeconds - lifecycleSnapshot.snapshotAt)
    : null;
  const isLifecycleSnapshotStale = lifecycleSnapshotAgeSeconds != null
    && lifecycleSnapshotAgeSeconds > TELEGRAM_LIFECYCLE_SNAPSHOT_STALE_SECONDS;

  const summaryCards = [
    {
      label: "Subscribers",
      value: telegramBot.totalChats,
      detail: `${telegramBot.alertEnabledChats} with active per-coin, global, launch, or saved alert defaults`,
    },
    {
      label: "Alert-Ready Chats",
      value: telegramBot.deliverableChats,
      detail: `${telegramBot.subscribedChats} chats currently have saved coin follows`,
    },
    {
      label: "Alert Follows",
      value: telegramBot.totalSubscriptions,
      detail: `${telegramBot.explicitCoinSubscriptions ?? telegramBot.totalSubscriptions} explicit, ${telegramBot.presetImpliedCoinSubscriptions ?? 0} preset-implied`,
    },
    {
      label: "Pending Queue",
      value: telegramBot.pendingDeliveries,
      detail:
        telegramBot.lastSubscriberActivityAt != null
          ? `${telegramBot.pendingDisambiguations} pending replies, last activity ${formatElapsedSeconds(Math.max(0, nowSeconds - telegramBot.lastSubscriberActivityAt))} ago`
          : `${telegramBot.pendingDisambiguations} pending replies`,
    },
  ];

  return (
    <div className="space-y-4">
      {telemetryQuality?.status === "partial" ? (
        <Card className="border-amber-500/35 bg-amber-500/10">
          <CardContent className="py-3 text-sm text-amber-800 dark:text-amber-200">
            Telegram telemetry is partial: {telemetryQuality.unavailableFields.join(", ")}
            {telemetryQuality.errors ? (
              <span className="block pt-1 font-mono text-xs">
                {Object.entries(telemetryQuality.errors).map(([field, message]) => `${field}: ${message}`).join(" · ")}
              </span>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
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
            {renderMetric("DEWS enabled", telegramBot.alertTypeChats.dews)}
            {renderMetric("Depeg enabled", telegramBot.alertTypeChats.depeg)}
            {renderMetric("Safety enabled", telegramBot.alertTypeChats.safety)}
            {renderMetric("Launch enabled", telegramBot.alertTypeChats.launch)}
            {renderMetric("All 4 alert types", telegramBot.alertTypeChats.allTypes)}
            <div className="border-t pt-3">
              {renderMetric("Custom preference chats", telegramBot.customPreferenceChats)}
              {renderMetric("Quiet hours enabled", telegramBot.quietHoursEnabledChats)}
              {renderMetric("Flags on, no coins", telegramBot.emptyAlertChats)}
              {renderMetric("Muted with saved coins", telegramBot.mutedChatsWithSubscriptions)}
            </div>
            <div className="border-t pt-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                Pending delivery telemetry
              </div>
              {renderMetric(
                "Oldest pending age",
                telegramBot.oldestPendingDeliveryAgeSec != null
                  ? formatElapsedSeconds(telegramBot.oldestPendingDeliveryAgeSec)
                  : null,
              )}
              {renderMetric("Backlog due", pendingBacklog?.due)}
              {renderMetric("Backlog deferred", pendingBacklog?.deferred)}
              {renderMetric("Backlog expired", pendingBacklog?.expired)}
              {renderMetric("Preset query failures", telegramBot.presetQueryFailures ?? 0)}
              {renderMetric("Preset followers", telegramBot.activePresetFollowers ?? 0)}
              {renderMetric("Inactive cleaned 7d", telegramBot.inactiveSubscribersCleanedThisWeek)}
            </div>
            {lifecycleSnapshot ? (
              <div className="border-t pt-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    Lifecycle snapshot
                  </div>
                  {isLifecycleSnapshotStale ? (
                    <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
                      snapshot stale · {formatElapsedSeconds(lifecycleSnapshotAgeSeconds ?? 0)} old
                    </Badge>
                  ) : null}
                </div>
                {renderMetric("Snapshot date", lifecycleSnapshot.date)}
                {renderMetric(
                  "Snapshot captured",
                  formatSnapshotCapturedAt(lifecycleSnapshot.snapshotAt, lifecycleSnapshotAgeSeconds ?? 0),
                )}
                {renderMetric("New watchers", lifecycleSnapshot.newWatchers)}
                {renderMetric("Churned watchers", lifecycleSnapshot.churnedWatchers)}
                {renderMetric("Reactivated watchers", lifecycleSnapshot.reactivatedWatchers)}
                {renderMetric("Preset-implied follows", lifecycleSnapshot.presetImpliedCoinFollows)}
              </div>
            ) : null}
            {retryErrorClasses.length > 0 ? (
              <div className="border-t pt-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Pending retry classes
                </div>
                <div className="space-y-1.5">
                  {retryErrorClasses.map(([errorClass, count]) => (
                    <div key={errorClass} className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{errorClass}</span>
                      <span className="font-mono tabular-nums">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
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
                    {formatElapsedSeconds(Math.max(0, nowSeconds - lastDispatch.startedAt))} ago
                  </span>
                  <span className="text-muted-foreground">{lastDispatch.itemCount ?? 0} messages counted</span>
                </div>
                {dispatchMeta?.skipped ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                    Run skipped: {dispatchMeta.skipped}
                  </div>
                ) : null}
                {dispatchMeta?.safetyAlertsSuppressed ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                    Safety alerts suppressed: {dispatchMeta.safetyAlertSourceState ?? "missing"}
                    {dispatchMeta.safetyAlertSourceAgeSeconds != null
                      ? ` · source age ${formatElapsedSeconds(dispatchMeta.safetyAlertSourceAgeSeconds)}`
                      : ""}
                  </div>
                ) : null}
                {renderMetric("Subscribers notified", dispatchMeta?.subscribersNotified ?? null)}
                {renderMetric("Messages sent", dispatchMeta?.messagesSent ?? lastDispatch.itemCount ?? null)}
                {renderMetric("Fresh attempted", dispatchMeta?.freshAttempted ?? null)}
                {renderMetric("Fresh retries queued", dispatchMeta?.freshRetryQueued ?? null)}
                {renderMetric("Fresh permanent failures", dispatchMeta?.freshPermanentFailures ?? null)}
                {renderMetric("Pending attempted", dispatchMeta?.pendingAttempted ?? null)}
                {renderMetric("Pending sent", dispatchMeta?.pendingDrained ?? null)}
                {renderMetric("Pending retries queued", dispatchMeta?.pendingRetryQueued ?? null)}
                {renderMetric("Pending deferred", dispatchMeta?.pendingDeferred ?? null)}
                {renderMetric("Pending dropped", dispatchMeta?.pendingDropped ?? null)}
                {renderMetric("Pending newly enqueued", dispatchMeta?.pendingEnqueued ?? null)}
                {renderMetric("Pending retry after", dispatchMeta?.pendingRetryAfterSec ?? null)}
                {renderMetric("Blocked cleaned up", dispatchMeta?.blockedUsersCleanedUp ?? null)}
                {renderMetric("Safety source age", dispatchMeta?.safetyAlertSourceAgeSeconds ?? null)}
                {renderMetric("DEWS changes", dispatchMeta?.eventsDetected?.dews ?? null)}
                {renderMetric("Depeg changes", dispatchMeta?.eventsDetected?.depeg ?? null)}
                {renderMetric("Depeg worsening", dispatchMeta?.eventsDetected?.depegWorsening ?? null)}
                {renderMetric("Safety changes", dispatchMeta?.eventsDetected?.safety ?? null)}
                {renderMetric("Launch changes", dispatchMeta?.eventsDetected?.launch ?? null)}
                {renderMetric("Methodology suppressions", dispatchMeta?.eventsDetected?.suppressedMethodologyChanges ?? null)}
                {dispatchMeta?.perAlertType ? (
                  <div className="border-t pt-3">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      Per-alert-type delivery
                    </div>
                    <div className="space-y-1.5 text-xs">
                      {(Object.keys(PER_ALERT_TYPE_LABELS) as TelegramAlertType[]).map((type) => {
                        const stats = dispatchMeta.perAlertType?.[type];
                        if (!stats) return null;
                        return (
                          <div
                            key={type}
                            className="grid grid-cols-[6rem_repeat(4,minmax(0,1fr))_minmax(0,1.25fr)] items-center gap-2 font-mono tabular-nums"
                          >
                            <span className="text-sm font-medium text-foreground">{PER_ALERT_TYPE_LABELS[type]}</span>
                            <span title="sent">sent {stats.sent}</span>
                            <span title="enqueued">enq {stats.enqueued}</span>
                            <span title="failed">fail {stats.failed}</span>
                            <span title="blocked">blk {stats.blocked}</span>
                            <span className="text-muted-foreground" title="first send latency">
                              {stats.firstSendLatencyMs != null ? `${stats.firstSendLatencyMs}ms` : "—"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-1">
                  {dispatchMeta?.snapshotSeeded ? <Badge variant="secondary">snapshot reseeded</Badge> : null}
                  {dispatchMeta?.cappedAtLimit ? <Badge variant="secondary">hit message cap</Badge> : null}
                  {dispatchMeta?.pendingRateLimited ? <Badge variant="secondary">pending rate limited</Badge> : null}
                  {dispatchMeta?.safetyAlertSourceState && dispatchMeta.safetyAlertSourceState !== "ok" ? (
                    <Badge variant="secondary">{dispatchMeta.safetyAlertSourceState}</Badge>
                  ) : null}
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
                      <div className="truncate text-xs text-muted-foreground">
                        {coin.stablecoinId}
                        {coin.presetImpliedSubscribers ? (
                          <> · {coin.explicitSubscribers ?? coin.subscribers} explicit + {coin.presetImpliedSubscribers} preset</>
                        ) : null}
                      </div>
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
