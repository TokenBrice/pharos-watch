import { formatElapsedSeconds } from "@shared/lib/format";
import {
  PENDING_DRAIN_TIME_ALERT_SEC,
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_OLD_AGE_ALERT_SEC,
} from "@shared/lib/telegram-delivery-policy";
import {
  readMetadataBoolean,
  readMetadataNumber,
  readMetadataRecord,
  readMetadataString,
} from "@shared/lib/status-metadata";
import { TELEGRAM_LIFECYCLE_SNAPSHOT_REFRESH_SECONDS } from "@shared/lib/status-thresholds";
import type {
  CronRunStatus,
  CronStatus,
  StatusResponse,
  TelegramAlertType,
  TelegramDeliverySliStatus,
} from "@shared/types";

export type CommsDeliveryHealth = "healthy" | "degraded" | "failed" | "unknown";
export type CommsBacklogAssessment = "within-policy" | "attention" | "unknown";

export interface CommsPriorityMetric {
  id:
    | "delivery-health"
    | "pending-backlog"
    | "oldest-backlog"
    | "permanent-failures"
    | "rate-limiting"
    | "latest-dispatch";
  label: string;
}

export interface CommsRecoveryLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface CommsWorkbenchModel {
  priorityMetrics: CommsPriorityMetric[];
  delivery: {
    health: CommsDeliveryHealth;
    healthReason: string;
    pendingDeliveries: number | null;
    oldestBacklogAgeSec: number | null;
    duePendingAgeSec: number | null;
    estimatedDrainTimeSec: number | null;
    backlog: {
      claimable: number | null;
      due: number | null;
      deferred: number | null;
      expired: number | null;
      nearTtl: number | null;
      sending: number | null;
      executionUnknown: number | null;
      pendingExecutionUnknown: number | null;
      freshExecutionUnknown: number | null;
      oldestExecutionUnknownAgeSec: number | null;
      sentCleanup: number | null;
    };
    backlogAssessment: CommsBacklogAssessment;
    backlogReasons: string[];
    backlogPolicy: {
      oldestAgeSec: number;
      estimatedDrainTimeSec: number;
      nearTtlWindowSec: number;
      countThresholdShared: false;
    };
    permanentFailures: {
      total: number | null;
      pendingNonRetryable: number | null;
      maxAttempts: number | null;
    };
    retries: {
      totalQueued: number | null;
      pendingQueued: number | null;
      rateLimited: boolean | null;
      retryAfterSec: number | null;
      errorClasses: Array<{ errorClass: string; count: number }> | null;
    };
    latestDispatch: {
      status: CronRunStatus | null;
      startedAt: number | null;
      ageSec: number | null;
      durationMs: number | null;
      itemCount: number | null;
      error: string | null;
      skipped: string | null;
      subscribersNotified: number | null;
      messagesSent: number | null;
      pendingAttempted: number | null;
      pendingDrained: number | null;
      pendingDeferred: number | null;
      pendingDropped: number | null;
      pendingDroppedTtlExpired: number | null;
      cappedAtLimit: boolean | null;
      snapshotSeeded: boolean | null;
      safetyAlertsSuppressed: boolean | null;
      safetySourceState: string | null;
      reserveAlertsSuppressed: boolean | null;
      reserveSourceState: string | null;
    };
    sli: TelegramDeliverySliStatus | null;
    recoveryLinks: CommsRecoveryLink[];
  };
  audience: {
    totalChats: number | null;
    alertEnabledChats: number | null;
    deliverableChats: number | null;
    subscribedChats: number | null;
    emptyAlertChats: number | null;
    mutedChatsWithSubscriptions: number | null;
    totalSubscriptions: number | null;
    explicitCoinSubscriptions: number | null;
    presetImpliedCoinSubscriptions: number | null;
    activePresetFollowers: number | null;
    averageSubscriptionsPerChat: number | null;
    lastSubscriberActivityAt: number | null;
    customPreferenceChats: number | null;
    quietHoursEnabledChats: number | null;
    alertTypeChats: Record<TelegramAlertType | "allTypes", number | null>;
    presetQueryFailures: number | null;
    inactiveSubscribersCleanedThisWeek: number | null;
    topStablecoins: Array<{
      stablecoinId: string;
      symbol: string;
      subscribers: number;
      explicitSubscribers: number | null;
      presetImpliedSubscribers: number | null;
    }>;
    lifecycle: {
      available: boolean;
      stale: boolean | null;
      ageSec: number | null;
      date: string | null;
      snapshotAt: number | null;
      activeWatchers: number | null;
      newWatchers: number | null;
      churnedWatchers: number | null;
      reactivatedWatchers: number | null;
      presetImpliedCoinFollows: number | null;
    };
  };
  quality: {
    status: "complete" | "partial" | "unknown";
    unavailableFields: string[];
    errors: Array<{ field: string; message: string }>;
    sectionError: string | null;
  };
}

const PRIORITY_METRICS: CommsPriorityMetric[] = [
  { id: "delivery-health", label: "Delivery health" },
  { id: "pending-backlog", label: "Pending backlog" },
  { id: "oldest-backlog", label: "Oldest backlog age" },
  { id: "permanent-failures", label: "Permanent failures" },
  { id: "rate-limiting", label: "Rate limiting and retries" },
  { id: "latest-dispatch", label: "Latest dispatch" },
];

const REPOSITORY_BLOB_URL = "https://github.com/TokenBrice/pharos-watch/blob/main";

function readOptionalNumber(value: unknown): number | null {
  return value == null ? null : readMetadataNumber(value);
}

function readOptionalBoolean(value: unknown): boolean | null {
  return value == null ? null : readMetadataBoolean(value);
}

function sumKnown(values: Array<number | null>): number | null {
  return values.every((value): value is number => value != null) ? values.reduce((sum, value) => sum + value, 0) : null;
}

function hasUnavailableField(unavailableFields: Set<string>, field: string): boolean {
  return unavailableFields.has(field);
}

function optionalBotNumber(
  telegramBot: StatusResponse["telegramBot"],
  unavailableFields: Set<string>,
  field: keyof NonNullable<StatusResponse["telegramBot"]>,
): number | null {
  if (!telegramBot || hasUnavailableField(unavailableFields, String(field))) return null;
  const value = telegramBot[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildRecoveryLinks(input: {
  health: CommsDeliveryHealth;
  backlogAssessment: CommsBacklogAssessment;
  rateLimited: boolean | null;
  permanentFailures: number | null;
}): CommsRecoveryLink[] {
  if (input.health === "healthy") return [];

  const links: CommsRecoveryLink[] = [
    { label: "Inspect dispatch cron", href: "/admin/crons/" },
    { label: "Open delivery actions", href: "/admin/actions/" },
  ];

  if (input.backlogAssessment === "attention") {
    links.push({
      label: "Backlog expiration runbook",
      href: `${REPOSITORY_BLOB_URL}/docs/runbooks/telegram-delivery.md#backlog-and-expiration`,
      external: true,
    });
  }
  if (input.rateLimited) {
    links.push({
      label: "Rate-limit runbook",
      href: `${REPOSITORY_BLOB_URL}/docs/runbooks/telegram-delivery.md#rate-limit-storm`,
      external: true,
    });
  }
  if (input.health === "failed" || (input.permanentFailures ?? 0) > 0) {
    links.push({
      label: "No-delivery runbook",
      href: `${REPOSITORY_BLOB_URL}/docs/runbooks/telegram-delivery.md`,
      external: true,
    });
  }

  return links;
}

export function buildCommsWorkbenchModel(input: {
  telegramBot: StatusResponse["telegramBot"];
  dispatchCron?: CronStatus;
  sectionError?: { message: string };
  nowSeconds: number;
}): CommsWorkbenchModel {
  const { telegramBot, dispatchCron, sectionError, nowSeconds } = input;
  const lastDispatch = dispatchCron?.runs[0] ?? null;
  // Registry-selected dispatch counters of the latest run (`latestRunFacts`).
  const metadata = readMetadataRecord(dispatchCron?.latestRunFacts);
  const unavailableFields = new Set(telegramBot?.quality?.unavailableFields ?? []);

  const pendingTelemetryAvailable =
    telegramBot != null &&
    !hasUnavailableField(unavailableFields, "pendingDeliveryBacklog") &&
    telegramBot.pendingDeliveryBacklog != null;
  const pendingBacklog = pendingTelemetryAvailable ? telegramBot.pendingDeliveryBacklog : null;
  const pendingDeliveries = telegramBot?.pendingDeliveries ?? null;
  const oldestPendingAgeSec = pendingTelemetryAvailable ? (telegramBot.oldestPendingDeliveryAgeSec ?? null) : null;
  const duePendingAgeSec = pendingTelemetryAvailable ? (telegramBot.oldestDuePendingAgeSec ?? null) : null;
  const oldestBacklogAgeSec = duePendingAgeSec ?? oldestPendingAgeSec;
  const estimatedDrainTimeSec = pendingTelemetryAvailable ? (telegramBot.estimatedDrainTimeSec ?? null) : null;
  const nearTtl = pendingBacklog?.nearTtl ?? null;

  const backlogReasons: string[] = [];
  if (oldestBacklogAgeSec != null && oldestBacklogAgeSec >= PENDING_OLD_AGE_ALERT_SEC) {
    backlogReasons.push(
      `Oldest queued delivery reached the ${PENDING_OLD_AGE_ALERT_SEC / 60}-minute policy threshold.`,
    );
  }
  if (estimatedDrainTimeSec != null && estimatedDrainTimeSec >= PENDING_DRAIN_TIME_ALERT_SEC) {
    backlogReasons.push(
      `Estimated drain time reached the ${PENDING_DRAIN_TIME_ALERT_SEC / 60}-minute policy threshold.`,
    );
  }
  if (nearTtl != null && nearTtl > 0) {
    backlogReasons.push(
      `${nearTtl} queued ${nearTtl === 1 ? "delivery is" : "deliveries are"} within the near-TTL window.`,
    );
  }

  const backlogTelemetryComplete =
    pendingTelemetryAvailable &&
    estimatedDrainTimeSec != null &&
    nearTtl != null &&
    (pendingDeliveries === 0 || oldestBacklogAgeSec != null);
  const backlogAssessment: CommsBacklogAssessment =
    backlogReasons.length > 0 ? "attention" : backlogTelemetryComplete ? "within-policy" : "unknown";

  const pendingPermanentFailures = readOptionalNumber(metadata?.pendingDroppedPermanentFailure);
  const maxAttemptsFailures = readOptionalNumber(metadata?.pendingDroppedMaxAttemptsFallback);
  const permanentFailures = sumKnown([pendingPermanentFailures, maxAttemptsFailures]);
  const pendingRetryQueued = readOptionalNumber(metadata?.pendingRetryQueued);
  const retryTotal = pendingRetryQueued;
  const rateLimited = readOptionalBoolean(metadata?.pendingRateLimited);
  const safetyAlertsSuppressed = readOptionalBoolean(metadata?.safetyAlertsSuppressed);
  const safetySourceState = readMetadataString(metadata?.safetyAlertSourceState);
  const reserveAlertsSuppressed = readOptionalBoolean(metadata?.reserveAlertsSuppressed);
  const reserveSourceState = readMetadataString(metadata?.reserveAlertSourceState);
  const suppressionReasons: string[] = [];
  if (safetyAlertsSuppressed === true) {
    suppressionReasons.push(`Safety alerts are suppressed because their source input is ${safetySourceState ?? "unknown"}.`);
  }
  if (reserveAlertsSuppressed === true) {
    suppressionReasons.push(`Reserve alerts are suppressed because their source input is ${reserveSourceState ?? "unknown"}.`);
  }

  let health: CommsDeliveryHealth;
  let healthReason: string;
  if (lastDispatch?.status === "error" || (permanentFailures ?? 0) > 0) {
    health = "failed";
    healthReason =
      lastDispatch?.status === "error"
        ? "The latest dispatch failed."
        : `${permanentFailures} permanent ${permanentFailures === 1 ? "failure was" : "failures were"} recorded in the latest dispatch.`;
  } else if (
    lastDispatch?.status === "degraded" ||
    backlogAssessment === "attention" ||
    rateLimited === true ||
    (retryTotal ?? 0) > 0 ||
    suppressionReasons.length > 0
  ) {
    health = "degraded";
    healthReason =
      backlogAssessment === "attention"
        ? (backlogReasons[0] ?? "Backlog policy requires attention.")
        : rateLimited
          ? "Telegram rate limiting affected the latest dispatch."
          : (retryTotal ?? 0) > 0
            ? "The latest dispatch queued delivery retries."
            : suppressionReasons.length > 0
              ? suppressionReasons.join(" ")
              : "The latest dispatch reported a degraded outcome.";
  } else if (
    !telegramBot ||
    !lastDispatch ||
    lastDispatch.status !== "ok" ||
    !metadata ||
    permanentFailures == null ||
    retryTotal == null ||
    rateLimited == null ||
    backlogAssessment === "unknown"
  ) {
    health = "unknown";
    healthReason = !telegramBot
      ? "Telegram delivery telemetry is unavailable."
      : !lastDispatch
        ? "No dispatch run is available."
        : "Required delivery evidence is incomplete, so health cannot be classified safely.";
  } else {
    health = "healthy";
    healthReason = "The latest dispatch completed without backlog, retry, rate-limit, or permanent-failure signals.";
  }

  const retryErrorClasses = hasUnavailableField(unavailableFields, "retryErrorClassCounts")
    ? null
    : telegramBot?.retryErrorClassCounts
      ? Object.entries(telegramBot.retryErrorClassCounts)
          .map(([errorClass, count]) => ({ errorClass, count }))
          .sort((a, b) => b.count - a.count || a.errorClass.localeCompare(b.errorClass))
      : null;

  const lifecycle = telegramBot?.lifecycleSnapshot ?? null;
  const lifecycleAgeSec = lifecycle ? Math.max(0, nowSeconds - lifecycle.snapshotAt) : null;
  const recoveryLinks = buildRecoveryLinks({
    health,
    backlogAssessment,
    rateLimited,
    permanentFailures,
  });

  return {
    priorityMetrics: PRIORITY_METRICS.map((metric) => ({ ...metric })),
    delivery: {
      health,
      healthReason,
      pendingDeliveries,
      oldestBacklogAgeSec,
      duePendingAgeSec,
      estimatedDrainTimeSec,
      backlog: {
        claimable: pendingBacklog?.claimable ?? null,
        due: pendingBacklog?.due ?? null,
        deferred: pendingBacklog?.deferred ?? null,
        expired: pendingBacklog?.expired ?? null,
        nearTtl,
        sending: pendingBacklog?.sending ?? null,
        executionUnknown: pendingBacklog?.executionUnknown ?? null,
        pendingExecutionUnknown: pendingBacklog?.pendingExecutionUnknown ?? null,
        freshExecutionUnknown: pendingBacklog?.freshExecutionUnknown ?? null,
        oldestExecutionUnknownAgeSec: pendingBacklog?.oldestExecutionUnknownAgeSec ?? null,
        sentCleanup: pendingBacklog?.sentCleanup ?? null,
      },
      backlogAssessment,
      backlogReasons,
      backlogPolicy: {
        oldestAgeSec: PENDING_OLD_AGE_ALERT_SEC,
        estimatedDrainTimeSec: PENDING_DRAIN_TIME_ALERT_SEC,
        nearTtlWindowSec: PENDING_NEAR_TTL_WINDOW_SEC,
        countThresholdShared: false,
      },
      permanentFailures: {
        total: permanentFailures,
        pendingNonRetryable: pendingPermanentFailures,
        maxAttempts: maxAttemptsFailures,
      },
      retries: {
        totalQueued: retryTotal,
        pendingQueued: pendingRetryQueued,
        rateLimited,
        retryAfterSec: readOptionalNumber(metadata?.pendingRetryAfterSec),
        errorClasses: retryErrorClasses,
      },
      latestDispatch: {
        status: lastDispatch?.status ?? null,
        startedAt: lastDispatch?.startedAt ?? null,
        ageSec: lastDispatch ? Math.max(0, nowSeconds - lastDispatch.startedAt) : null,
        durationMs: lastDispatch?.durationMs ?? null,
        itemCount: lastDispatch?.itemCount ?? null,
        error: lastDispatch?.error ?? null,
        skipped: readMetadataString(metadata?.skipped) ?? lastDispatch?.skippedReason ?? null,
        subscribersNotified: readOptionalNumber(metadata?.subscribersNotified),
        messagesSent: readOptionalNumber(metadata?.messagesSent),
        pendingAttempted: readOptionalNumber(metadata?.pendingAttempted),
        pendingDrained: readOptionalNumber(metadata?.pendingDrained),
        pendingDeferred: readOptionalNumber(metadata?.pendingDeferred),
        pendingDropped: readOptionalNumber(metadata?.pendingDropped),
        pendingDroppedTtlExpired: readOptionalNumber(metadata?.pendingDroppedTtlExpired),
        cappedAtLimit: readOptionalBoolean(metadata?.cappedAtLimit),
        snapshotSeeded: readOptionalBoolean(metadata?.snapshotSeeded),
        safetyAlertsSuppressed,
        safetySourceState,
        reserveAlertsSuppressed,
        reserveSourceState,
      },
      sli: telegramBot?.deliverySli ?? null,
      recoveryLinks,
    },
    audience: {
      totalChats: telegramBot?.totalChats ?? null,
      alertEnabledChats: telegramBot?.alertEnabledChats ?? null,
      deliverableChats: telegramBot?.deliverableChats ?? null,
      subscribedChats: telegramBot?.subscribedChats ?? null,
      emptyAlertChats: telegramBot?.emptyAlertChats ?? null,
      mutedChatsWithSubscriptions: telegramBot?.mutedChatsWithSubscriptions ?? null,
      totalSubscriptions: telegramBot?.totalSubscriptions ?? null,
      explicitCoinSubscriptions: optionalBotNumber(telegramBot, unavailableFields, "explicitCoinSubscriptions"),
      presetImpliedCoinSubscriptions: optionalBotNumber(
        telegramBot,
        unavailableFields,
        "presetImpliedCoinSubscriptions",
      ),
      activePresetFollowers: optionalBotNumber(telegramBot, unavailableFields, "activePresetFollowers"),
      averageSubscriptionsPerChat: telegramBot?.avgSubscriptionsPerSubscribedChat ?? null,
      lastSubscriberActivityAt: telegramBot?.lastSubscriberActivityAt ?? null,
      customPreferenceChats: telegramBot?.customPreferenceChats ?? null,
      quietHoursEnabledChats: telegramBot?.quietHoursEnabledChats ?? null,
      alertTypeChats: {
        dews: telegramBot?.alertTypeChats.dews ?? null,
        depeg: telegramBot?.alertTypeChats.depeg ?? null,
        safety: telegramBot?.alertTypeChats.safety ?? null,
        launch: telegramBot?.alertTypeChats.launch ?? null,
        reserve: telegramBot?.alertTypeChats.reserve ?? null,
        freeze: telegramBot?.alertTypeChats.freeze ?? null,
        allTypes: telegramBot?.alertTypeChats.allTypes ?? null,
      },
      presetQueryFailures: hasUnavailableField(unavailableFields, "presetQueryFailures")
        ? null
        : telegramBot
          ? (telegramBot.presetQueryFailures ?? 0)
          : null,
      inactiveSubscribersCleanedThisWeek: optionalBotNumber(
        telegramBot,
        unavailableFields,
        "inactiveSubscribersCleanedThisWeek",
      ),
      topStablecoins:
        telegramBot?.topStablecoins.map((coin) => ({
          stablecoinId: coin.stablecoinId,
          symbol: coin.symbol,
          subscribers: coin.subscribers,
          explicitSubscribers: coin.explicitSubscribers ?? null,
          presetImpliedSubscribers: coin.presetImpliedSubscribers ?? null,
        })) ?? [],
      lifecycle: {
        available: lifecycle != null,
        stale: lifecycleAgeSec == null ? null : lifecycleAgeSec > TELEGRAM_LIFECYCLE_SNAPSHOT_REFRESH_SECONDS * 2,
        ageSec: lifecycleAgeSec,
        date: lifecycle?.date ?? null,
        snapshotAt: lifecycle?.snapshotAt ?? null,
        activeWatchers: lifecycle?.activeWatchers ?? null,
        newWatchers: lifecycle?.newWatchers ?? null,
        churnedWatchers: lifecycle?.churnedWatchers ?? null,
        reactivatedWatchers: lifecycle?.reactivatedWatchers ?? null,
        presetImpliedCoinFollows: lifecycle?.presetImpliedCoinFollows ?? null,
      },
    },
    quality: {
      status: telegramBot?.quality?.status ?? "unknown",
      unavailableFields: [...unavailableFields].sort(),
      errors: Object.entries(telegramBot?.quality?.errors ?? {})
        .map(([field, message]) => ({ field, message }))
        .sort((a, b) => a.field.localeCompare(b.field)),
      sectionError: sectionError?.message ?? null,
    },
  };
}

/** An empty queue has no oldest item; Unknown means genuinely missing telemetry. */
export function formatOldestBacklogAge(ageSec: number | null, pendingDeliveries: number | null): string {
  if (ageSec != null) return formatElapsedSeconds(ageSec);
  return pendingDeliveries === 0 ? "No backlog" : "Unknown";
}

/** True only when every value is a measured zero; any missing value keeps the full table visible. */
export function allMeasuredZero(values: readonly (number | null)[]): boolean {
  return values.every((value) => value === 0);
}
