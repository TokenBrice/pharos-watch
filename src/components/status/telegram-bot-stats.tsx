import Link from "next/link";
import { AlertTriangle, ArrowRight, CircleCheck, CircleHelp, CircleX, ExternalLink } from "lucide-react";
import { formatElapsedSeconds } from "@shared/lib/format";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { Button } from "@/components/ui/button";
import type {
  CommsDeliveryHealth,
  CommsPerAlertDeliveryRow,
  CommsPriorityMetric,
  CommsWorkbenchModel,
} from "@/lib/comms-workbench-model";
import { cn } from "@/lib/utils";

interface TelegramBotStatsProps {
  model: CommsWorkbenchModel;
}

const HEALTH_PRESENTATION: Record<CommsDeliveryHealth, { label: string; className: string; icon: typeof CircleCheck }> =
  {
    healthy: {
      label: "Healthy",
      className: "text-emerald-700 dark:text-emerald-300",
      icon: CircleCheck,
    },
    degraded: {
      label: "Degraded",
      className: "text-amber-700 dark:text-amber-300",
      icon: AlertTriangle,
    },
    failed: {
      label: "Failed",
      className: "text-red-700 dark:text-red-300",
      icon: CircleX,
    },
    unknown: {
      label: "Unknown",
      className: "text-muted-foreground",
      icon: CircleHelp,
    },
  };

function formatCount(value: number | null): string {
  return value == null ? "Unknown" : value.toLocaleString();
}

function formatDuration(value: number | null): string {
  return value == null ? "Unknown" : formatElapsedSeconds(value);
}

function formatMilliseconds(value: number | null): string {
  return value == null ? "Unknown" : `${value.toLocaleString()}ms`;
}

export type PerAlertMetricDescriptor = {
  key: "sent" | "enqueued" | "failed" | "blocked" | "firstSendLatencyMs";
  label: string;
  accessor: (row: CommsPerAlertDeliveryRow) => number | null;
  formatter: (value: number | null) => string;
  desktop: {
    width: string;
    alignment: "text-left" | "text-right";
  };
};

export const PER_ALERT_METRICS = [
  {
    key: "sent",
    label: "Sent",
    accessor: (row) => row.sent,
    formatter: formatCount,
    desktop: { width: "w-[12%]", alignment: "text-right" },
  },
  {
    key: "enqueued",
    label: "Enqueued",
    accessor: (row) => row.enqueued,
    formatter: formatCount,
    desktop: { width: "w-[14%]", alignment: "text-right" },
  },
  {
    key: "failed",
    label: "Failed",
    accessor: (row) => row.failed,
    formatter: formatCount,
    desktop: { width: "w-[12%]", alignment: "text-right" },
  },
  {
    key: "blocked",
    label: "Blocked",
    accessor: (row) => row.blocked,
    formatter: formatCount,
    desktop: { width: "w-[12%]", alignment: "text-right" },
  },
  {
    key: "firstSendLatencyMs",
    label: "First send latency",
    accessor: (row) => row.firstSendLatencyMs,
    formatter: formatMilliseconds,
    desktop: { width: "w-[26%]", alignment: "text-right" },
  },
] as const satisfies readonly PerAlertMetricDescriptor[];

function formatTimestamp(value: number | null): string {
  return value == null ? "Unknown" : new Date(value * 1_000).toLocaleString();
}

function formatBoolean(value: boolean | null): string {
  return value == null ? "Unknown" : value ? "Yes" : "No";
}

function formatStatus(value: string | null): string {
  if (value == null) return "Unknown";
  return value.replaceAll("_", " ");
}

function MetricRow({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-0.5 py-1.5 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <dt className="min-w-0 break-words text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 max-w-full break-words font-mono tabular-nums [overflow-wrap:anywhere] sm:text-right",
          valueClassName,
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function DeliveryHealthValue({ health }: { health: CommsDeliveryHealth }) {
  const presentation = HEALTH_PRESENTATION[health];
  const Icon = presentation.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-semibold", presentation.className)}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {presentation.label}
    </span>
  );
}

function PriorityValue({ metric, model }: { metric: CommsPriorityMetric; model: CommsWorkbenchModel }) {
  const { delivery } = model;
  switch (metric.id) {
    case "delivery-health":
      return (
        <>
          <DeliveryHealthValue health={delivery.health} />
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{delivery.healthReason}</span>
        </>
      );
    case "pending-backlog":
      return (
        <>
          <span className="font-mono text-lg font-semibold tabular-nums">
            {formatCount(delivery.pendingDeliveries)}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {delivery.backlogAssessment === "attention"
              ? "Shared policy needs attention"
              : delivery.backlogAssessment === "within-policy"
                ? "Within shared policy"
                : "Policy assessment Unknown"}
          </span>
        </>
      );
    case "oldest-backlog":
      return (
        <span className="font-mono text-lg font-semibold tabular-nums">
          {formatDuration(delivery.oldestBacklogAgeSec)}
        </span>
      );
    case "permanent-failures":
      return (
        <span
          className={cn(
            "font-mono text-lg font-semibold tabular-nums",
            (delivery.permanentFailures.total ?? 0) > 0 && "text-red-700 dark:text-red-300",
          )}
        >
          {formatCount(delivery.permanentFailures.total)}
        </span>
      );
    case "rate-limiting":
      return (
        <>
          <span className="font-medium">
            {delivery.retries.rateLimited == null
              ? "Unknown"
              : delivery.retries.rateLimited
                ? "Rate limited"
                : "Not rate limited"}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {delivery.retries.totalQueued == null
              ? "Queued retries Unknown"
              : `${delivery.retries.totalQueued.toLocaleString()} queued ${delivery.retries.totalQueued === 1 ? "retry" : "retries"}`}
          </span>
        </>
      );
    case "latest-dispatch":
      return (
        <>
          <span className="font-medium capitalize">{formatStatus(delivery.latestDispatch.status)}</span>
          <span className="mt-1 block font-mono text-xs tabular-nums text-muted-foreground">
            {delivery.latestDispatch.ageSec == null
              ? "Run age Unknown"
              : `${formatDuration(delivery.latestDispatch.ageSec)} ago`}
          </span>
        </>
      );
  }
}

function DeliveryPriority({ model }: { model: CommsWorkbenchModel }) {
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-x-5 sm:grid-cols-2 xl:grid-cols-3" data-testid="comms-priority-order">
      {model.priorityMetrics.map((metric) => (
        <div key={metric.id} className="min-w-0 border-t border-border/60 py-3" data-metric-id={metric.id}>
          <dt className="text-xs font-medium uppercase text-muted-foreground">{metric.label}</dt>
          <dd className="min-w-0 pt-1 [overflow-wrap:anywhere]">
            <PriorityValue metric={metric} model={model} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RecoverySummary({ model }: { model: CommsWorkbenchModel }) {
  const { delivery } = model;
  if (delivery.health === "healthy") return null;
  const presentation = HEALTH_PRESENTATION[delivery.health];

  return (
    <div
      className={cn(
        "min-w-0 border-l-2 py-2 pl-3",
        delivery.health === "failed"
          ? "border-red-500"
          : delivery.health === "degraded"
            ? "border-amber-500"
            : "border-border",
      )}
      data-testid="comms-recovery-summary"
    >
      <p className={cn("text-sm font-medium", presentation.className)}>{delivery.healthReason}</p>
      {delivery.backlogReasons.length > 1 ? (
        <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
          {delivery.backlogReasons.slice(1).map((reason) => (
            <li key={reason} className="min-w-0 break-words">
              {reason}
            </li>
          ))}
        </ul>
      ) : null}
      {delivery.recoveryLinks.length > 0 ? (
        <div className="mt-3 flex min-w-0 flex-wrap gap-2">
          {delivery.recoveryLinks.map((link) => (
            <Button key={link.href} asChild size="sm" variant="outline" className="min-h-11 max-w-full sm:min-h-8">
              <Link href={link.href} {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                <span className="min-w-0 break-words">{link.label}</span>
                {link.external ? <ExternalLink aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
              </Link>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TelemetryNotice({ model }: { model: CommsWorkbenchModel }) {
  if (model.quality.status === "complete" && !model.quality.sectionError) return null;

  return (
    <div className="min-w-0 border-l-2 border-amber-500 py-2 pl-3 text-sm" data-testid="telegram-telemetry-notice">
      <p className="font-medium text-amber-800 dark:text-amber-200">
        {model.quality.status === "partial" ? "Telegram telemetry is partial." : "Telegram telemetry is Unknown."}
      </p>
      {model.quality.unavailableFields.length > 0 ? (
        <p className="mt-1 min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
          Unavailable fields: {model.quality.unavailableFields.join(", ")}
        </p>
      ) : null}
      {model.quality.sectionError ? (
        <p className="mt-1 min-w-0 break-words font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {model.quality.sectionError}
        </p>
      ) : null}
      {model.quality.errors.map(({ field, message }) => (
        <p
          key={field}
          className="mt-1 min-w-0 break-words font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
        >
          {field}: {message}
        </p>
      ))}
    </div>
  );
}

function BacklogTelemetry({ model }: { model: CommsWorkbenchModel }) {
  const { delivery } = model;
  return (
    <section aria-labelledby="comms-backlog-title" className="min-w-0 border-t border-border/60 pt-3">
      <h3 id="comms-backlog-title" className="text-sm font-semibold text-foreground">
        Queue state
      </h3>
      <dl className="mt-2 min-w-0 divide-y divide-border/40">
        <MetricRow label="Claimable now" value={formatCount(delivery.backlog.claimable)} />
        <MetricRow label="Due" value={formatCount(delivery.backlog.due)} />
        <MetricRow label="Deferred" value={formatCount(delivery.backlog.deferred)} />
        <MetricRow label="Expired" value={formatCount(delivery.backlog.expired)} />
        <MetricRow label="Near TTL" value={formatCount(delivery.backlog.nearTtl)} />
        <MetricRow label="Sending" value={formatCount(delivery.backlog.sending)} />
        <MetricRow label="Execution Unknown" value={formatCount(delivery.backlog.executionUnknown)} />
        <MetricRow label="Pending execution Unknown" value={formatCount(delivery.backlog.pendingExecutionUnknown)} />
        <MetricRow label="Fresh execution Unknown" value={formatCount(delivery.backlog.freshExecutionUnknown)} />
        <MetricRow
          label="Oldest execution Unknown"
          value={formatDuration(delivery.backlog.oldestExecutionUnknownAgeSec)}
        />
        <MetricRow label="Sent cleanup" value={formatCount(delivery.backlog.sentCleanup)} />
        <MetricRow label="Estimated drain" value={formatDuration(delivery.estimatedDrainTimeSec)} />
      </dl>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Attention uses the shared {formatDuration(delivery.backlogPolicy.oldestAgeSec)} age and{" "}
        {formatDuration(delivery.backlogPolicy.estimatedDrainTimeSec)} drain policies plus near-TTL risk. Queue size is
        measured only; its watchdog threshold remains backend-owned and is not duplicated here.
      </p>
    </section>
  );
}

function RetryTelemetry({ model }: { model: CommsWorkbenchModel }) {
  const { permanentFailures, retries } = model.delivery;
  return (
    <section aria-labelledby="comms-retry-title" className="min-w-0 border-t border-border/60 pt-3">
      <h3 id="comms-retry-title" className="text-sm font-semibold text-foreground">
        Failure and retry classes
      </h3>
      <dl className="mt-2 min-w-0 divide-y divide-border/40">
        <MetricRow label="Fresh permanent" value={formatCount(permanentFailures.fresh)} />
        <MetricRow label="Pending non-retryable" value={formatCount(permanentFailures.pendingNonRetryable)} />
        <MetricRow label="Max-attempt drops" value={formatCount(permanentFailures.maxAttempts)} />
        <MetricRow label="Fresh retries queued" value={formatCount(retries.freshQueued)} />
        <MetricRow label="Pending retries queued" value={formatCount(retries.pendingQueued)} />
        <MetricRow label="Rate limited" value={formatBoolean(retries.rateLimited)} />
        <MetricRow label="Retry after" value={formatDuration(retries.retryAfterSec)} />
      </dl>
      {retries.errorClasses == null ? (
        <p className="mt-3 text-xs text-muted-foreground">Pending retry-class telemetry is Unknown.</p>
      ) : retries.errorClasses.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No pending retry classes.</p>
      ) : (
        <div className="mt-3 min-w-0 overflow-hidden">
          <TableFrame
            tableId="telegram-retry-classes"
            chrome="bare"
            density="compact"
            tableClassName="table-fixed border-collapse text-left text-xs"
            viewportProps={{ mobileScrollHint: false, scrollShadow: false, compactBottomPadding: false }}
          >
            <TableCaption className="sr-only">Pending Telegram retry error classes</TableCaption>
            <TableHeader className="text-muted-foreground">
              <TableRow rowIntent="static">
                <TableHead scope="col" className="h-auto w-3/4 whitespace-normal px-0 pb-1 pr-3 font-medium">
                  Error class
                </TableHead>
                <TableHead scope="col" className="h-auto w-1/4 whitespace-normal px-0 pb-1 text-right font-medium">
                  Pending
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {retries.errorClasses.map(({ errorClass, count }) => (
                <TableRow key={errorClass} rowIntent="static" className="border-t border-border/40">
                  <TableHead
                    scope="row"
                    className="h-auto min-w-0 whitespace-normal px-0 py-1.5 pr-3 font-mono font-normal [overflow-wrap:anywhere]"
                  >
                    {errorClass}
                  </TableHead>
                  <TableCell className="whitespace-normal px-0 py-1.5 text-right font-mono tabular-nums">
                    {count.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableFrame>
        </div>
      )}
    </section>
  );
}

function LatestDispatch({ model }: { model: CommsWorkbenchModel }) {
  const dispatch = model.delivery.latestDispatch;
  return (
    <section aria-labelledby="comms-latest-dispatch-title" className="min-w-0 border-t border-border/60 pt-3">
      <h3 id="comms-latest-dispatch-title" className="text-sm font-semibold text-foreground">
        Latest dispatch outcome
      </h3>
      <dl className="mt-2 min-w-0 divide-y divide-border/40">
        <MetricRow label="Outcome" value={formatStatus(dispatch.status)} valueClassName="capitalize" />
        <MetricRow label="Started" value={formatTimestamp(dispatch.startedAt)} />
        <MetricRow label="Run age" value={formatDuration(dispatch.ageSec)} />
        <MetricRow label="Duration" value={formatMilliseconds(dispatch.durationMs)} />
        <MetricRow label="Messages sent" value={formatCount(dispatch.messagesSent)} />
        <MetricRow label="Subscribers notified" value={formatCount(dispatch.subscribersNotified)} />
        <MetricRow
          label="Fresh attempted / sent"
          value={`${formatCount(dispatch.freshAttempted)} / ${formatCount(dispatch.freshSent)}`}
        />
        <MetricRow
          label="Pending attempted / sent"
          value={`${formatCount(dispatch.pendingAttempted)} / ${formatCount(dispatch.pendingDrained)}`}
        />
        <MetricRow
          label="Pending deferred / dropped"
          value={`${formatCount(dispatch.pendingDeferred)} / ${formatCount(dispatch.pendingDropped)}`}
        />
        <MetricRow label="TTL-expired drops" value={formatCount(dispatch.pendingDroppedTtlExpired)} />
        <MetricRow label="Message cap reached" value={formatBoolean(dispatch.cappedAtLimit)} />
        <MetricRow label="Snapshot reseeded" value={formatBoolean(dispatch.snapshotSeeded)} />
        <MetricRow label="Safety source" value={dispatch.safetySourceState ?? "Unknown"} />
        <MetricRow label="Safety alerts suppressed" value={formatBoolean(dispatch.safetyAlertsSuppressed)} />
        <MetricRow label="Reserve source" value={dispatch.reserveSourceState ?? "Unknown"} />
        <MetricRow label="Reserve alerts suppressed" value={formatBoolean(dispatch.reserveAlertsSuppressed)} />
      </dl>
      {dispatch.skipped ? (
        <p className="mt-2 min-w-0 break-words text-xs text-amber-700 [overflow-wrap:anywhere] dark:text-amber-300">
          Skipped: {dispatch.skipped}
        </p>
      ) : null}
      {dispatch.error ? (
        <p className="mt-2 min-w-0 break-words font-mono text-xs text-red-700 [overflow-wrap:anywhere] dark:text-red-300">
          {dispatch.error}
        </p>
      ) : null}
    </section>
  );
}

function MobilePerAlertRow({ row }: { row: CommsPerAlertDeliveryRow }) {
  return (
    <div className="min-w-0 border-t border-border/60 py-3 first:border-t-0" data-alert-type={row.type}>
      <div className="text-sm font-medium text-foreground">{row.label}</div>
      <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 pt-2 text-xs">
        {PER_ALERT_METRICS.map((metric) => (
          <div
            key={metric.key}
            className={cn("min-w-0", metric.key === "firstSendLatencyMs" && "col-span-2")}
            data-metric-key={metric.key}
          >
            <dt className="text-muted-foreground">{metric.label}</dt>
            <dd
              className={cn(
                "font-mono tabular-nums",
                metric.key === "firstSendLatencyMs" && "min-w-0 break-words [overflow-wrap:anywhere]",
              )}
            >
              {metric.formatter(metric.accessor(row))}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PerAlertDelivery({ model }: { model: CommsWorkbenchModel }) {
  const rows = model.delivery.perAlertType;
  return (
    <section aria-labelledby="comms-per-alert-title" className="min-w-0 border-t border-border/60 pt-4">
      <h3 id="comms-per-alert-title" className="text-sm font-semibold text-foreground">
        Per-alert delivery
      </h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Per-alert delivery telemetry is Unknown.</p>
      ) : (
        <>
          <div className="mt-2 min-w-0 sm:hidden" data-testid="telegram-delivery-mobile">
            {rows.map((row) => (
              <MobilePerAlertRow key={row.type} row={row} />
            ))}
          </div>
          <div
            className="mt-2 hidden min-w-0 max-w-full overflow-x-auto sm:block"
            data-testid="telegram-delivery-desktop"
          >
            <TableFrame
              tableId="telegram-per-alert-delivery"
              chrome="bare"
              density="compact"
              tableClassName="table-fixed border-collapse text-left text-xs tabular-nums"
              viewportProps={{ mobileScrollHint: false, scrollShadow: false, compactBottomPadding: false }}
            >
              <TableCaption className="sr-only">Per-alert Telegram delivery results</TableCaption>
              <TableHeader className="text-muted-foreground">
                <TableRow rowIntent="static">
                  <TableHead scope="col" className="h-auto w-[24%] whitespace-normal px-0 pb-2 pr-2 font-medium">
                    Alert type
                  </TableHead>
                  {PER_ALERT_METRICS.map((metric) => (
                    <TableHead
                      key={metric.key}
                      scope="col"
                      aria-label={metric.label}
                      data-metric-key={metric.key}
                      className={cn(
                        "h-auto whitespace-normal px-0 pb-2 font-medium",
                        metric.desktop.width,
                        metric.desktop.alignment,
                      )}
                    >
                      {metric.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.type} rowIntent="static" className="border-t border-border/60">
                    <TableHead
                      scope="row"
                      className="h-auto min-w-0 whitespace-normal px-0 py-2 pr-2 text-sm font-medium"
                    >
                      {row.label}
                    </TableHead>
                    {PER_ALERT_METRICS.map((metric) => (
                      <TableCell
                        key={metric.key}
                        data-metric-key={metric.key}
                        className={cn(
                          "whitespace-normal px-0 py-2 font-mono",
                          metric.desktop.alignment,
                          metric.key === "firstSendLatencyMs" && "min-w-0 [overflow-wrap:anywhere]",
                        )}
                      >
                        {metric.formatter(metric.accessor(row))}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </TableFrame>
          </div>
        </>
      )}
    </section>
  );
}

function AudienceCoverage({ model }: { model: CommsWorkbenchModel }) {
  const { audience } = model;
  return (
    <section aria-labelledby="audience-coverage-title" className="min-w-0 border-t border-border/60 pt-5">
      <div>
        <h2 id="audience-coverage-title" className="text-base font-semibold text-foreground">
          Audience Coverage
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Subscriber reach and preferences, separated from current delivery operations.
        </p>
      </div>

      <div className="mt-3 grid min-w-0 gap-x-6 gap-y-4 lg:grid-cols-3">
        <section aria-labelledby="audience-reach-title" className="min-w-0 border-t border-border/60 pt-3">
          <h3 id="audience-reach-title" className="text-sm font-semibold text-foreground">
            Reach
          </h3>
          <dl className="mt-2 min-w-0 divide-y divide-border/40">
            <MetricRow label="Subscriber chats" value={formatCount(audience.totalChats)} />
            <MetricRow label="Alert enabled" value={formatCount(audience.alertEnabledChats)} />
            <MetricRow label="Alert ready" value={formatCount(audience.deliverableChats)} />
            <MetricRow label="Saved coin follows" value={formatCount(audience.subscribedChats)} />
            <MetricRow label="Total follows" value={formatCount(audience.totalSubscriptions)} />
            <MetricRow label="Explicit follows" value={formatCount(audience.explicitCoinSubscriptions)} />
            <MetricRow label="Preset-implied follows" value={formatCount(audience.presetImpliedCoinSubscriptions)} />
            <MetricRow label="Preset followers" value={formatCount(audience.activePresetFollowers)} />
            <MetricRow label="Average follows / chat" value={formatCount(audience.averageSubscriptionsPerChat)} />
          </dl>
        </section>

        <section aria-labelledby="audience-preferences-title" className="min-w-0 border-t border-border/60 pt-3">
          <h3 id="audience-preferences-title" className="text-sm font-semibold text-foreground">
            Preferences
          </h3>
          <dl className="mt-2 min-w-0 divide-y divide-border/40">
            <MetricRow label="DEWS" value={formatCount(audience.alertTypeChats.dews)} />
            <MetricRow label="Depeg" value={formatCount(audience.alertTypeChats.depeg)} />
            <MetricRow label="Safety" value={formatCount(audience.alertTypeChats.safety)} />
            <MetricRow label="Launch" value={formatCount(audience.alertTypeChats.launch)} />
            <MetricRow label="Reserve" value={formatCount(audience.alertTypeChats.reserve)} />
            <MetricRow label="All alert types" value={formatCount(audience.alertTypeChats.allTypes)} />
            <MetricRow label="Custom preferences" value={formatCount(audience.customPreferenceChats)} />
            <MetricRow label="Quiet hours" value={formatCount(audience.quietHoursEnabledChats)} />
            <MetricRow label="Enabled, no coins" value={formatCount(audience.emptyAlertChats)} />
            <MetricRow label="Muted with coins" value={formatCount(audience.mutedChatsWithSubscriptions)} />
          </dl>
        </section>

        <section aria-labelledby="audience-top-coins-title" className="min-w-0 border-t border-border/60 pt-3">
          <h3 id="audience-top-coins-title" className="text-sm font-semibold text-foreground">
            Top subscribed coins
          </h3>
          {model.quality.status === "unknown" ? (
            <p className="mt-2 text-sm text-muted-foreground">Coin subscription coverage is Unknown.</p>
          ) : audience.topStablecoins.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No saved coin subscriptions.</p>
          ) : (
            <ul className="mt-2 min-w-0 divide-y divide-border/40">
              {audience.topStablecoins.map((coin) => (
                <li key={coin.stablecoinId} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">{coin.symbol}</div>
                    <div className="min-w-0 break-words font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {coin.stablecoinId}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {formatCount(coin.explicitSubscribers)} explicit / {formatCount(coin.presetImpliedSubscribers)}{" "}
                      preset
                    </div>
                  </div>
                  <span className="font-mono tabular-nums">{coin.subscribers.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <details className="mt-4 min-w-0 border-t border-border/60 pt-3">
        <summary className="min-h-11 cursor-pointer rounded-sm py-3 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-0 sm:py-0">
          Lifecycle and secondary telemetry
        </summary>
        <div className="mt-3 grid min-w-0 gap-x-6 lg:grid-cols-2">
          <dl className="min-w-0 divide-y divide-border/40">
            <MetricRow label="Pending disambiguations" value={formatCount(audience.pendingDisambiguations)} />
            <MetricRow label="Last subscriber activity" value={formatTimestamp(audience.lastSubscriberActivityAt)} />
            <MetricRow label="Preset query failures" value={formatCount(audience.presetQueryFailures)} />
            <MetricRow label="Webhook effects Unknown" value={formatCount(audience.webhookEffectUnknown)} />
            <MetricRow label="Inactive cleaned, 7d" value={formatCount(audience.inactiveSubscribersCleanedThisWeek)} />
          </dl>
          <dl className="min-w-0 divide-y divide-border/40">
            <MetricRow label="Lifecycle date" value={audience.lifecycle.date ?? "Unknown"} />
            <MetricRow label="Snapshot captured" value={formatTimestamp(audience.lifecycle.snapshotAt)} />
            <MetricRow label="Snapshot age" value={formatDuration(audience.lifecycle.ageSec)} />
            <MetricRow label="Snapshot stale" value={formatBoolean(audience.lifecycle.stale)} />
            <MetricRow label="Active watchers" value={formatCount(audience.lifecycle.activeWatchers)} />
            <MetricRow label="New watchers" value={formatCount(audience.lifecycle.newWatchers)} />
            <MetricRow label="Churned watchers" value={formatCount(audience.lifecycle.churnedWatchers)} />
            <MetricRow label="Reactivated watchers" value={formatCount(audience.lifecycle.reactivatedWatchers)} />
            <MetricRow
              label="Preset-implied follows"
              value={formatCount(audience.lifecycle.presetImpliedCoinFollows)}
            />
          </dl>
        </div>
      </details>
    </section>
  );
}

export function TelegramBotStats({ model }: TelegramBotStatsProps) {
  return (
    <div className="min-w-0 space-y-5">
      <TelemetryNotice model={model} />

      <section aria-labelledby="delivery-operations-title" className="min-w-0">
        <div>
          <h2 id="delivery-operations-title" className="text-base font-semibold text-foreground">
            Delivery Operations
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Current Telegram dispatch outcome, queue pressure, and failure evidence.
          </p>
        </div>

        <div className="mt-3 min-w-0">
          <DeliveryPriority model={model} />
        </div>
        <RecoverySummary model={model} />

        <div className="mt-4 grid min-w-0 gap-x-6 gap-y-4 lg:grid-cols-3">
          <BacklogTelemetry model={model} />
          <RetryTelemetry model={model} />
          <LatestDispatch model={model} />
        </div>

        <PerAlertDelivery model={model} />
      </section>

      <AudienceCoverage model={model} />
    </div>
  );
}
