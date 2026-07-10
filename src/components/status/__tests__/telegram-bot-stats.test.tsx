// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CronStatus, StatusResponse } from "@shared/types";
import { buildCommsWorkbenchModel } from "@/lib/comms-workbench-model";
import { TelegramBotStats } from "../telegram-bot-stats";

const NOW_SECONDS = 1_771_858_200;
const LIFECYCLE_SNAPSHOT_AT = NOW_SECONDS - 1_800;

function telegramBot(): NonNullable<StatusResponse["telegramBot"]> {
  return {
    totalChats: 10,
    alertEnabledChats: 8,
    deliverableChats: 8,
    subscribedChats: 6,
    emptyAlertChats: 1,
    mutedChatsWithSubscriptions: 2,
    totalSubscriptions: 15,
    explicitCoinSubscriptions: 11,
    presetImpliedCoinSubscriptions: 4,
    activePresetFollowers: 2,
    avgSubscriptionsPerSubscribedChat: 2.5,
    pendingDisambiguations: 1,
    pendingDeliveries: 0,
    lastSubscriberActivityAt: NOW_SECONDS - 300,
    customPreferenceChats: 4,
    quietHoursEnabledChats: 3,
    alertTypeChats: {
      dews: 5,
      depeg: 4,
      safety: 3,
      launch: 2,
      reserve: 1,
      allTypes: 1,
    },
    topStablecoins: [
      {
        stablecoinId: "stablecoin-with-a-very-long-identifier-that-must-wrap-locally",
        symbol: "LONG",
        subscribers: 5,
        explicitSubscribers: 3,
        presetImpliedSubscribers: 2,
      },
    ],
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
    presetQueryFailures: 0,
    inactiveSubscribersCleanedThisWeek: 6,
    webhookEffectUnknown: 0,
    lifecycleSnapshot: {
      date: "2026-02-24",
      snapshotAt: LIFECYCLE_SNAPSHOT_AT,
      activeWatchers: 8,
      newWatchers: 2,
      churnedWatchers: 1,
      reactivatedWatchers: 1,
      explicitCoinFollows: 11,
      presetImpliedCoinFollows: 4,
      activePresetFollowers: 2,
      alertTypeOptIns: {
        dews: 5,
        depeg: 4,
        safety: 3,
        launch: 2,
        reserve: 1,
        allTypes: 1,
      },
      quietHoursEnabledChats: 3,
      pendingDeliveries: 0,
    },
    quality: { status: "complete", unavailableFields: [] },
  };
}

function dispatchMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function dispatchCron(
  metadata: Record<string, unknown> = dispatchMetadata(),
  status: "ok" | "degraded" | "error" = "ok",
  error?: string,
): CronStatus {
  return {
    lastRun: {
      startedAt: NOW_SECONDS - 60,
      durationMs: 1_200,
      status,
      itemCount: 0,
      metadata,
      ...(error ? { error } : {}),
    },
    recentRuns: [],
    expectedIntervalSec: 300,
    healthy: status === "ok",
  };
}

function renderWorkbench(input?: {
  bot?: StatusResponse["telegramBot"];
  cron?: CronStatus;
  sectionError?: { message: string };
}) {
  const model = buildCommsWorkbenchModel({
    telegramBot: input && "bot" in input ? (input.bot ?? null) : telegramBot(),
    dispatchCron: input?.cron ?? dispatchCron(),
    sectionError: input?.sectionError,
    nowSeconds: NOW_SECONDS,
  });
  return render(<TelegramBotStats model={model} />);
}

afterEach(cleanup);

describe("TelegramBotStats", () => {
  it("leads with delivery evidence in the model priority order and separates audience coverage", () => {
    renderWorkbench();

    const deliveryHeading = screen.getByRole("heading", { name: "Delivery Operations" });
    const audienceHeading = screen.getByRole("heading", { name: "Audience Coverage" });
    expect(deliveryHeading.compareDocumentPosition(audienceHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const priority = screen.getByTestId("comms-priority-order");
    expect(
      [...priority.querySelectorAll("[data-metric-id]")].map((element) => element.getAttribute("data-metric-id")),
    ).toEqual([
      "delivery-health",
      "pending-backlog",
      "oldest-backlog",
      "permanent-failures",
      "rate-limiting",
      "latest-dispatch",
    ]);
    expect(within(priority).getByText("Healthy")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Queue state" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Failure and retry classes" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Latest dispatch outcome" })).toBeTruthy();
  });

  it("renders missing evidence as Unknown while preserving measured zeroes", () => {
    const { container } = renderWorkbench({ bot: null, cron: dispatchCron({}) });

    expect(screen.getByText("Telegram telemetry is Unknown.")).toBeTruthy();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(10);
    expect(container.textContent).not.toContain("—");

    cleanup();
    renderWorkbench();
    const pendingMetric = document.querySelector('[data-metric-id="pending-backlog"]');
    const failureMetric = document.querySelector('[data-metric-id="permanent-failures"]');
    expect(pendingMetric?.textContent).toContain("0");
    expect(failureMetric?.textContent).toContain("0");
    expect(screen.getByText("Not rate limited")).toBeTruthy();
  });

  it("surfaces policy-based backlog attention without applying a client count threshold", () => {
    const bot = telegramBot();
    renderWorkbench({
      bot: {
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
    });

    expect(screen.getByText("Shared policy needs attention")).toBeTruthy();
    expect(screen.getAllByText(/15-minute policy threshold/).length).toBeGreaterThan(0);
    expect(screen.getByText(/30-minute policy threshold/)).toBeTruthy();
    expect(screen.getByText(/watchdog threshold remains backend-owned/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Backlog expiration runbook/i }).getAttribute("href")).toContain(
      "telegram-backlog-expiration.md",
    );
  });

  it("uses a semantic desktop table and labeled mobile rows for every alert type", () => {
    renderWorkbench({
      cron: dispatchCron(
        dispatchMetadata({
          perAlertType: {
            dews: { sent: 3, enqueued: 1, failed: 0, blocked: 0, firstSendLatencyMs: 240 },
            depeg: { sent: 1, enqueued: 2, failed: 1, blocked: 0, firstSendLatencyMs: null },
          },
        }),
      ),
    });

    const mobile = screen.getByTestId("telegram-delivery-mobile");
    const desktop = screen.getByTestId("telegram-delivery-desktop");
    expect(mobile.className).toContain("sm:hidden");
    expect(mobile.querySelectorAll("dl")).toHaveLength(5);
    expect(within(mobile).getAllByText("First send latency")).toHaveLength(5);
    expect(within(mobile).getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(desktop.className).toContain("overflow-x-auto");
    expect(desktop.className).toContain("sm:block");
    expect(desktop.querySelector("table")?.className).toContain("table-fixed");
    expect(desktop.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(within(desktop).getByText("Alert type")).toBeTruthy();
    expect(within(desktop).getByText("First latency")).toBeTruthy();
  });

  it("wraps long diagnostics locally and exposes real recovery cross-links on failure", () => {
    const longError = "dispatch_failed_with_an_extremely_long_unbroken_identifier_that_must_not_expand_the_document";
    const bot = telegramBot();
    renderWorkbench({
      bot: {
        ...bot,
        retryErrorClassCounts: {
          gateway_timeout_after_fixture_retry_budget_with_an_extremely_long_suffix: 5,
        },
      },
      cron: dispatchCron(
        dispatchMetadata({
          freshPermanentFailures: 1,
          freshRetryQueued: 2,
          pendingRetryQueued: 0,
          pendingRateLimited: true,
          pendingRetryAfterSec: 45,
        }),
        "error",
        longError,
      ),
    });

    const retryClass = screen.getByText("gateway_timeout_after_fixture_retry_budget_with_an_extremely_long_suffix");
    const error = screen.getByText(longError);
    const coinId = screen.getByText("stablecoin-with-a-very-long-identifier-that-must-wrap-locally");
    expect(retryClass.className).toContain("[overflow-wrap:anywhere]");
    expect(error.className).toContain("[overflow-wrap:anywhere]");
    expect(coinId.className).toContain("[overflow-wrap:anywhere]");
    expect(screen.getByRole("link", { name: /Inspect dispatch cron/i }).getAttribute("href")).toBe("/admin/crons");
    expect(screen.getByRole("link", { name: /Open delivery actions/i }).getAttribute("href")).toBe("/admin/actions");
    const runbook = screen.getByRole("link", { name: /No-delivery runbook/i });
    expect(runbook.getAttribute("href")).toContain("telegram-no-delivery.md");
    expect(runbook.getAttribute("target")).toBe("_blank");
  });

  it("keeps lifecycle counters secondary and renders partial field diagnostics", () => {
    const bot = telegramBot();
    renderWorkbench({
      bot: {
        ...bot,
        quality: {
          status: "partial",
          unavailableFields: ["pendingDeliveryBacklog"],
          errors: { pendingDeliveryBacklog: "no such table with_a_long_unbroken_name" },
        },
      },
    });

    expect(screen.getByText("Telegram telemetry is partial.")).toBeTruthy();
    expect(screen.getByText(/Unavailable fields: pendingDeliveryBacklog/)).toBeTruthy();
    expect(screen.getByText(/no such table with_a_long_unbroken_name/).className).toContain("[overflow-wrap:anywhere]");
    const lifecycle = screen.getByText("Lifecycle and secondary telemetry");
    expect(lifecycle.closest("details")).toBeTruthy();
    expect(screen.getByText("Snapshot captured").parentElement?.className).toContain("grid-cols-1");
  });
});
