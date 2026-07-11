import { describe, expect, it } from "vitest";
import type { CronStatus, StatusResponse } from "@shared/types";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { buildCommsWorkbenchModel } from "../comms-workbench-model";

const NOW_SECONDS = 1_700_001_000;

function completeTelegramBot(): NonNullable<StatusResponse["telegramBot"]> {
  const bot = makeHealthyStatusResponse().telegramBot!;
  return {
    ...bot,
    explicitCoinSubscriptions: 12,
    presetImpliedCoinSubscriptions: 3,
    activePresetFollowers: 2,
    pendingDeliveries: 0,
    oldestPendingDeliveryAgeSec: null,
    oldestDuePendingAgeSec: null,
    estimatedDrainTimeSec: 0,
    pendingDeliveryBacklog: {
      claimable: 0,
      due: 0,
      deferred: 0,
      expired: 0,
      nearTtl: 0,
      executionUnknown: 0,
      completedPendingCleanup: 0,
    },
    retryErrorClassCounts: {},
    webhookEffectUnknown: 0,
    quality: { status: "complete", unavailableFields: [] },
  };
}

function dispatchCron(metadata: Record<string, unknown>, status: "ok" | "degraded" | "error" = "ok"): CronStatus {
  return {
    lastRun: {
      startedAt: NOW_SECONDS - 60,
      durationMs: 1_200,
      status,
      itemCount: 0,
      metadata,
    },
    recentRuns: [],
    expectedIntervalSec: 300,
    healthy: status === "ok",
  };
}

function completeDispatchMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subscribersNotified: 0,
    messagesSent: 0,
    freshAttempted: 0,
    freshSent: 0,
    freshRetryQueued: 0,
    freshPermanentFailures: 0,
    pendingAttempted: 0,
    pendingDrained: 0,
    pendingRetryQueued: 0,
    pendingDroppedPermanentFailure: 0,
    pendingDroppedMaxAttemptsFallback: 0,
    pendingRateLimited: false,
    safetyAlertsSuppressed: false,
    reserveAlertsSuppressed: false,
    ...overrides,
  };
}

describe("buildCommsWorkbenchModel", () => {
  it("keeps the operator priority order stable", () => {
    const model = buildCommsWorkbenchModel({
      telegramBot: completeTelegramBot(),
      dispatchCron: dispatchCron(completeDispatchMetadata()),
      nowSeconds: NOW_SECONDS,
    });

    expect(model.priorityMetrics.map((metric) => metric.id)).toEqual([
      "delivery-health",
      "pending-backlog",
      "oldest-backlog",
      "permanent-failures",
      "rate-limiting",
      "latest-dispatch",
    ]);
    expect(model.delivery.health).toBe("healthy");
  });

  it("preserves measured zeroes but marks missing Telegram and dispatch evidence unknown", () => {
    const missing = buildCommsWorkbenchModel({ telegramBot: null, nowSeconds: NOW_SECONDS });
    expect(missing.delivery.health).toBe("unknown");
    expect(missing.delivery.pendingDeliveries).toBeNull();
    expect(missing.delivery.permanentFailures.total).toBeNull();
    expect(missing.audience.totalChats).toBeNull();

    const measuredZero = buildCommsWorkbenchModel({
      telegramBot: completeTelegramBot(),
      dispatchCron: dispatchCron(completeDispatchMetadata()),
      nowSeconds: NOW_SECONDS,
    });
    expect(measuredZero.delivery.pendingDeliveries).toBe(0);
    expect(measuredZero.delivery.permanentFailures.total).toBe(0);
    expect(measuredZero.delivery.retries.rateLimited).toBe(false);

    const missingMetadata = buildCommsWorkbenchModel({
      telegramBot: completeTelegramBot(),
      dispatchCron: dispatchCron({}),
      nowSeconds: NOW_SECONDS,
    });
    expect(missingMetadata.delivery.health).toBe("unknown");
    expect(missingMetadata.delivery.permanentFailures.total).toBeNull();
    expect(missingMetadata.delivery.retries.rateLimited).toBeNull();
  });

  it("uses shared age, drain, and near-TTL policy without classifying queue size by a client threshold", () => {
    const bot = completeTelegramBot();
    const model = buildCommsWorkbenchModel({
      telegramBot: {
        ...bot,
        pendingDeliveries: 2,
        oldestPendingDeliveryAgeSec: 901,
        oldestDuePendingAgeSec: 901,
        estimatedDrainTimeSec: 1_801,
        pendingDeliveryBacklog: {
          ...bot.pendingDeliveryBacklog!,
          claimable: 1,
          due: 1,
          deferred: 1,
          nearTtl: 1,
        },
      },
      dispatchCron: dispatchCron(completeDispatchMetadata()),
      nowSeconds: NOW_SECONDS,
    });

    expect(model.delivery.backlogAssessment).toBe("attention");
    expect(model.delivery.health).toBe("degraded");
    expect(model.delivery.backlogReasons).toHaveLength(3);
    expect(model.delivery.backlogPolicy).toMatchObject({
      oldestAgeSec: 900,
      estimatedDrainTimeSec: 1_800,
      nearTtlWindowSec: 900,
      countThresholdShared: false,
    });
  });

  it("prioritizes permanent failures and retains retry, rate-limit, and latest-dispatch evidence", () => {
    const model = buildCommsWorkbenchModel({
      telegramBot: {
        ...completeTelegramBot(),
        retryErrorClassCounts: { rate_limit: 4, gateway_timeout: 2 },
      },
      dispatchCron: dispatchCron(
        completeDispatchMetadata({
          freshRetryQueued: 2,
          pendingRetryQueued: 3,
          freshPermanentFailures: 1,
          pendingDroppedPermanentFailure: 2,
          pendingDroppedMaxAttemptsFallback: 3,
          pendingRateLimited: true,
          pendingRetryAfterSec: 45,
          messagesSent: 12,
        }),
      ),
      nowSeconds: NOW_SECONDS,
    });

    expect(model.delivery.health).toBe("failed");
    expect(model.delivery.permanentFailures.total).toBe(6);
    expect(model.delivery.retries).toMatchObject({
      totalQueued: 5,
      freshQueued: 2,
      pendingQueued: 3,
      rateLimited: true,
      retryAfterSec: 45,
    });
    expect(model.delivery.retries.errorClasses?.map((entry) => entry.errorClass)).toEqual([
      "rate_limit",
      "gateway_timeout",
    ]);
    expect(model.delivery.latestDispatch).toMatchObject({
      status: "ok",
      startedAt: NOW_SECONDS - 60,
      ageSec: 60,
      messagesSent: 12,
    });
    expect(model.delivery.recoveryLinks.map((link) => link.href)).toContain("/admin/crons/");
    expect(model.delivery.recoveryLinks.map((link) => link.href)).toContain("/admin/actions/");
    expect(model.delivery.recoveryLinks.some((link) => link.href.includes("telegram-rate-limit-storm.md"))).toBe(true);
    expect(model.delivery.recoveryLinks.some((link) => link.href.includes("telegram-no-delivery.md"))).toBe(true);
  });

  it("keeps absent per-alert values unknown instead of manufacturing zeroes", () => {
    const model = buildCommsWorkbenchModel({
      telegramBot: completeTelegramBot(),
      dispatchCron: dispatchCron(
        completeDispatchMetadata({
          perAlertType: {
            dews: { sent: 3, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: 240 },
          },
        }),
      ),
      nowSeconds: NOW_SECONDS,
    });

    expect(model.delivery.perAlertType).toHaveLength(6);
    expect(model.delivery.perAlertType[0]).toMatchObject({ type: "dews", sent: 3, enqueued: 0 });
    expect(model.delivery.perAlertType[1]).toMatchObject({
      type: "depeg",
      sent: null,
      enqueued: null,
      failed: null,
    });
  });
});
