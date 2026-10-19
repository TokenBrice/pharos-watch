import { describe, expect, it } from "vitest";
import type { CronStatus } from "@shared/types";
import { makeCompleteTelegramBotStatus, makeDispatchMetadata } from "@/test-utils/status-fixtures";
import {
  allMeasuredZero,
  buildCommsWorkbenchModel,
  formatFirstSendLatency,
  formatOldestBacklogAge,
} from "../comms-workbench-model";

const NOW_SECONDS = 1_700_001_000;

function dispatchCron(metadata: Record<string, unknown>, status: "ok" | "degraded" | "error" = "ok"): CronStatus {
  return {
    runs: [{
      startedAt: NOW_SECONDS - 60,
      durationMs: 1_200,
      status,
      itemCount: 0,
    }],
    latestRunFacts: metadata,
    confirmedOutputAt: status === "ok" ? NOW_SECONDS - 60 : null,
    expectedIntervalSec: 300,
    healthy: status === "ok",
  };
}

describe("buildCommsWorkbenchModel", () => {
  it("does not certify a present Telegram payload without quality as complete", () => {
    const bot = makeCompleteTelegramBotStatus();
    delete bot.quality;
    const model = buildCommsWorkbenchModel({
      telegramBot: bot,
      dispatchCron: dispatchCron(makeDispatchMetadata()),
      nowSeconds: NOW_SECONDS,
    });

    expect(model.quality).toEqual({
      status: "unknown",
      unavailableFields: [],
      errors: [],
      sectionError: null,
    });
    expect(model.audience.totalChats).toBe(bot.totalChats);
  });

  it.each(["complete", "partial", "unknown"] as const)("preserves supplied %s quality", (status) => {
    const model = buildCommsWorkbenchModel({
      telegramBot: {
        ...makeCompleteTelegramBotStatus(),
        quality: { status, unavailableFields: ["topCoins"], errors: { topCoins: "read failed" } },
      },
      nowSeconds: NOW_SECONDS,
    });

    expect(model.quality).toEqual({
      status,
      unavailableFields: ["topCoins"],
      errors: [{ field: "topCoins", message: "read failed" }],
      sectionError: null,
    });
  });

  it("preserves measured zeroes but marks missing Telegram and dispatch evidence unknown", () => {
    const missing = buildCommsWorkbenchModel({ telegramBot: null, nowSeconds: NOW_SECONDS });
    expect(missing.delivery.health).toBe("unknown");
    expect(missing.delivery.pendingDeliveries).toBeNull();
    expect(missing.delivery.permanentFailures.total).toBeNull();
    expect(missing.audience.totalChats).toBeNull();

    const measuredZero = buildCommsWorkbenchModel({
      telegramBot: makeCompleteTelegramBotStatus(),
      dispatchCron: dispatchCron(makeDispatchMetadata()),
      nowSeconds: NOW_SECONDS,
    });
    expect(measuredZero.delivery.pendingDeliveries).toBe(0);
    expect(measuredZero.delivery.permanentFailures.total).toBe(0);
    expect(measuredZero.delivery.retries.rateLimited).toBe(false);

    const missingMetadata = buildCommsWorkbenchModel({
      telegramBot: makeCompleteTelegramBotStatus(),
      dispatchCron: dispatchCron({}),
      nowSeconds: NOW_SECONDS,
    });
    expect(missingMetadata.delivery.health).toBe("unknown");
    expect(missingMetadata.delivery.permanentFailures.total).toBeNull();
    expect(missingMetadata.delivery.retries.rateLimited).toBeNull();
  });

  it("uses shared age, drain, and near-TTL policy without classifying queue size by a client threshold", () => {
    const bot = makeCompleteTelegramBotStatus();
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
      dispatchCron: dispatchCron(makeDispatchMetadata({ safetyAlertsSuppressed: true, safetyAlertSourceState: "stale" })),
      nowSeconds: NOW_SECONDS,
    });

    expect(model.delivery.backlogAssessment).toBe("attention");
    expect(model.delivery.health).toBe("degraded");
    expect(model.delivery.healthReason).toBe("Oldest queued delivery reached the 15-minute policy threshold.");
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
        ...makeCompleteTelegramBotStatus(),
        retryErrorClassCounts: { rate_limit: 4, gateway_timeout: 2 },
      },
      dispatchCron: dispatchCron(
        makeDispatchMetadata({
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
    expect(model.delivery.recoveryLinks.some((link) => link.href.includes("telegram-no-delivery.md#rate-limit-storm"))).toBe(true);
    expect(model.delivery.recoveryLinks.some((link) => link.href.includes("telegram-no-delivery.md"))).toBe(true);
  });

  it.each([
    [{ safetyAlertsSuppressed: true, safetyAlertSourceState: "stale" }, "Safety alerts are suppressed because their source input is stale."],
    [{ reserveAlertsSuppressed: true, reserveAlertSourceState: "unavailable" }, "Reserve alerts are suppressed because their source input is unavailable."],
    [{
      safetyAlertsSuppressed: true, safetyAlertSourceState: "held",
      reserveAlertsSuppressed: true, reserveAlertSourceState: "stale",
    }, "Safety alerts are suppressed because their source input is held. Reserve alerts are suppressed because their source input is stale."],
    [{ safetyAlertsSuppressed: true, safetyAlertSourceState: undefined }, "Safety alerts are suppressed because their source input is unknown."],
  ] as const)("explains source suppression without reporting a failed ok dispatch (%j)", (metadata, reason) => {
    const model = buildCommsWorkbenchModel({
      telegramBot: makeCompleteTelegramBotStatus(),
      dispatchCron: dispatchCron(makeDispatchMetadata(metadata)),
      nowSeconds: NOW_SECONDS,
    });
    expect(model.delivery.health).toBe("degraded");
    expect(model.delivery.healthReason).toBe(reason);
    expect(model.delivery.latestDispatch.status).toBe("ok");
    expect(model.delivery.permanentFailures.total).toBe(0);
    expect(model.delivery.retries.totalQueued).toBe(0);
  });

  it.each([
    ["error", {}, "failed", "The latest dispatch failed."],
    ["ok", { freshPermanentFailures: 1 }, "failed", "1 permanent failure was recorded in the latest dispatch."],
    ["ok", { freshRetryQueued: 1 }, "degraded", "The latest dispatch queued delivery retries."],
    ["ok", { pendingRateLimited: true }, "degraded", "Telegram rate limiting affected the latest dispatch."],
  ] as const)("preserves delivery failure and retry precedence over suppression (%s, %j)", (status, metadata, health, reason) => {
    const model = buildCommsWorkbenchModel({
      telegramBot: makeCompleteTelegramBotStatus(),
      dispatchCron: dispatchCron(makeDispatchMetadata({
        safetyAlertsSuppressed: true, safetyAlertSourceState: "stale", ...metadata,
      }), status),
      nowSeconds: NOW_SECONDS,
    });
    expect(model.delivery.health).toBe(health);
    expect(model.delivery.healthReason).toBe(reason);
  });

  it("reserves degraded-dispatch copy for an actual degraded terminal outcome", () => {
    const model = buildCommsWorkbenchModel({
      telegramBot: makeCompleteTelegramBotStatus(),
      dispatchCron: dispatchCron(makeDispatchMetadata(), "degraded"),
      nowSeconds: NOW_SECONDS,
    });
    expect(model.delivery.health).toBe("degraded");
    expect(model.delivery.healthReason).toBe("The latest dispatch reported a degraded outcome.");
  });

  it("treats an absent fresh retry counter as zero only on an ok dispatch with its sibling present", () => {
    // Live 2026-09-22 shape: dispatch ok, 0 permanent failures, empty backlog,
    // but the last run's metadata predates the fresh-side retry breakdown and
    // only carries pendingRetryQueued. Health must classify as healthy rather
    // than forcing the whole panel Unknown off one absent counter.
    const legacyShape = buildCommsWorkbenchModel({
      telegramBot: makeCompleteTelegramBotStatus(),
      dispatchCron: dispatchCron(makeDispatchMetadata({ freshRetryQueued: undefined })),
      nowSeconds: NOW_SECONDS,
    });
    expect(legacyShape.delivery.health).toBe("healthy");
    expect(legacyShape.delivery.retries.totalQueued).toBe(0);
    expect(legacyShape.delivery.retries.freshQueued).toBe(0);
    expect(legacyShape.delivery.retries.pendingQueued).toBe(0);

    // Sibling counter missing too, or a non-ok dispatch: evidence stays
    // unknown instead of manufacturing a zero.
    const noSibling = buildCommsWorkbenchModel({
      telegramBot: makeCompleteTelegramBotStatus(),
      dispatchCron: dispatchCron(
        makeDispatchMetadata({ freshRetryQueued: undefined, pendingRetryQueued: undefined }),
      ),
      nowSeconds: NOW_SECONDS,
    });
    expect(noSibling.delivery.health).toBe("unknown");
    expect(noSibling.delivery.retries.totalQueued).toBeNull();

    const degradedDispatch = buildCommsWorkbenchModel({
      telegramBot: makeCompleteTelegramBotStatus(),
      dispatchCron: dispatchCron(makeDispatchMetadata({ freshRetryQueued: undefined }), "degraded"),
      nowSeconds: NOW_SECONDS,
    });
    expect(degradedDispatch.delivery.health).toBe("degraded");
    expect(degradedDispatch.delivery.retries.totalQueued).toBeNull();
  });

  it("keeps absent per-alert values unknown instead of manufacturing zeroes", () => {
    const model = buildCommsWorkbenchModel({
      telegramBot: makeCompleteTelegramBotStatus(),
      dispatchCron: dispatchCron(
        makeDispatchMetadata({
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

describe("comms not-applicable formatting (A4)", () => {
  it("separates not-applicable from missing telemetry", () => {
    expect(formatOldestBacklogAge(null, 0)).toBe("No backlog");
    expect(formatOldestBacklogAge(null, null)).toBe("Unknown");
    expect(formatOldestBacklogAge(null, 3)).toBe("Unknown");
    expect(formatOldestBacklogAge(120, 3)).toBe("2m");
    expect(formatFirstSendLatency(null, 0)).toBe("None sent");
    expect(formatFirstSendLatency(null, null)).toBe("Unknown");
    expect(formatFirstSendLatency(1500, 2)).toBe("1,500ms");
  });

  it("collapses only when every value is a measured zero", () => {
    expect(allMeasuredZero([0, 0])).toBe(true);
    expect(allMeasuredZero([0, null])).toBe(false);
    expect(allMeasuredZero([0, 1])).toBe(false);
  });
});
