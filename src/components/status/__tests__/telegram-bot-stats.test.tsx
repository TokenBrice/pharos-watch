// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CronStatus, StatusResponse } from "@shared/types";
import { TELEGRAM_ALERT_FAMILY_SHORT_LABELS } from "@shared/lib/telegram-alert-families";
import { TELEGRAM_LIVE_ALERT_TYPES } from "@shared/types/status/telegram";
import { buildCommsWorkbenchModel } from "@/lib/comms-workbench-model";
import { makeAvailableTelegramDeliverySli, makeCompleteTelegramBotStatus, makeDispatchMetadata } from "@/test-utils/status-fixtures";
import { TelegramBotStats } from "../telegram-bot-stats";

const NOW_SECONDS = 1_771_858_200;
const LIFECYCLE_SNAPSHOT_AT = NOW_SECONDS - 1_800;

function telegramBot(): NonNullable<StatusResponse["telegramBot"]> {
  return {
    ...makeCompleteTelegramBotStatus({
      emptyAlertChats: 1,
      mutedChatsWithSubscriptions: 2,
      explicitCoinSubscriptions: 11,
      presetImpliedCoinSubscriptions: 4,
      lastSubscriberActivityAt: NOW_SECONDS - 300,
      customPreferenceChats: 4,
      quietHoursEnabledChats: 3,
      alertTypeChats: {
        dews: 5,
        depeg: 4,
        safety: 3,
        launch: 2,
        reserve: 1,
        freeze: 6,
        allTypes: 1,
      },
    }),
    topStablecoins: [
      {
        stablecoinId: "stablecoin-with-a-very-long-identifier-that-must-wrap-locally",
        symbol: "LONG",
        subscribers: 5,
        explicitSubscribers: 3,
        presetImpliedSubscribers: 2,
      },
    ],
    presetQueryFailures: 0,
    inactiveSubscribersCleanedThisWeek: 6,
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
  };
}

function dispatchCron(
  metadata: Record<string, unknown> = makeDispatchMetadata(),
  status: "ok" | "degraded" | "error" = "ok",
  error?: string,
): CronStatus {
  return {
    runs: [{
      startedAt: NOW_SECONDS - 60,
      durationMs: 1_200,
      status,
      itemCount: 0,
      ...(error ? { error } : {}),
    }],
    latestRunFacts: metadata,
    confirmedOutputAt: status === "ok" ? NOW_SECONDS - 60 : null,
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
  return { ...render(<TelegramBotStats model={model} />), model };
}


describe("TelegramBotStats", () => {
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
      "telegram-delivery.md#backlog-and-expiration",
    );
  });

  it("renders row-backed outcomes rather than synthetic family zeroes", () => {
    renderWorkbench({
      bot: { ...telegramBot(), deliverySli: makeAvailableTelegramDeliverySli() },
      cron: dispatchCron(makeDispatchMetadata({
        pendingAttempted: 4, pendingDrained: 3,
        perAlertType: { dews: { sent: 0 } },
      })),
    });
    const section = screen.getByRole("region", { name: "Authoritative target outcomes" });
    const observed = Object.fromEntries([...section.querySelectorAll("dl > div")].map((row) => [
      row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent,
    ]));
    expect(observed).toEqual({
      Targets: "28", "Telegram accepted": "7", Failed: "5", Cancelled: "4",
      Expired: "3", "Execution unknown": "2", Unresolved: "7", "Mixed-family targets": "5",
    });
    expect(section.textContent).toContain("evidence stale, quality partial");
    expect(section.textContent).toContain("not recipient delivery or read");
    expect(screen.queryByText("Per-alert delivery")).toBeNull();
    expect(screen.queryByText("Fresh attempted / sent")).toBeNull();
    expect(screen.getByText("4 / 3")).toBeTruthy();
  });

  it("keeps unavailable row-backed delivery outcomes unavailable", () => {
    renderWorkbench({ cron: dispatchCron(makeDispatchMetadata({ perAlertType: { dews: { sent: 0 } } })) });
    expect(screen.getByText("Row-backed delivery outcomes are unavailable.")).toBeTruthy();
    const section = screen.getByRole("region", { name: "Authoritative target outcomes" });
    expect(section.querySelector("dl")).toBeNull();
  });

  it("renders long unbroken diagnostics verbatim and exposes real recovery cross-links on failure", () => {
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
        makeDispatchMetadata({
          pendingDroppedPermanentFailure: 1,
          pendingRetryQueued: 2,
          pendingRateLimited: true,
          pendingRetryAfterSec: 45,
        }),
        "error",
        longError,
      ),
    });

    // Verbatim presence is asserted by getByText below; wrap containment is
    // measured by the visual/E2E owner, not by utility-class spelling.
    screen.getByText("gateway_timeout_after_fixture_retry_budget_with_an_extremely_long_suffix");
    screen.getByText(longError);
    screen.getByText("stablecoin-with-a-very-long-identifier-that-must-wrap-locally");
    expect(screen.getByRole("link", { name: /Inspect dispatch cron/i }).getAttribute("href")).toBe("/admin/crons");
    expect(screen.getByRole("link", { name: /Open delivery actions/i }).getAttribute("href")).toBe("/admin/actions");
    const runbook = screen.getByRole("link", { name: /No-delivery runbook/i });
    expect(runbook.getAttribute("href")).toContain("telegram-delivery.md");
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
    expect(screen.getByText(/no such table with_a_long_unbroken_name/)).toBeTruthy();
    const lifecycle = screen.getByText("Lifecycle and secondary telemetry");
    expect(lifecycle.closest("details")).toBeTruthy();
  });

  it("does not read a failed coin-ranking query as zero saved subscriptions", () => {
    const bot = telegramBot();
    renderWorkbench({
      bot: {
        ...bot,
        topStablecoins: [],
        quality: {
          status: "partial",
          unavailableFields: ["topStablecoins"],
          errors: { topStablecoins: "D1 unavailable" },
        },
      },
    });

    expect(screen.queryByText("No saved coin subscriptions.")).toBeNull();
    expect(screen.getByText("Coin subscription coverage is Unknown.")).toBeTruthy();
  });

  it("names the explicit-follow denominator and the chat count behind saved follows", () => {
    renderWorkbench();

    expect(screen.getByText("Chats with coin follows").parentElement?.textContent).toContain("6");
    expect(
      screen.getByText("Average explicit follows / chat with explicit follows").parentElement?.textContent,
    ).toContain("2");
    expect(screen.queryByText("Average follows / chat")).toBeNull();
    expect(screen.queryByText("Saved coin follows")).toBeNull();
  });

  it("renders every live alert family and omits the retired launch family", () => {
    const alertTypeChats = {
      dews: 11, depeg: 12, safety: 13, launch: 9, reserve: 14, freeze: 15, allTypes: 16,
    };
    renderWorkbench({ bot: { ...telegramBot(), alertTypeChats } });

    for (const type of TELEGRAM_LIVE_ALERT_TYPES) {
      const label = TELEGRAM_ALERT_FAMILY_SHORT_LABELS[type];
      expect(screen.getByText(label).parentElement?.textContent).toContain(String(alertTypeChats[type]));
    }
    expect(screen.getByText("Freeze")).toBeTruthy();
    expect(screen.queryByText("Launch")).toBeNull();
  });

  it("keeps measured coin rankings visible alongside an unrelated partial field", () => {
    const bot = telegramBot();
    renderWorkbench({
      bot: {
        ...bot,
        quality: {
          status: "partial",
          unavailableFields: ["pendingDeliveryBacklog"],
          errors: { pendingDeliveryBacklog: "D1 unavailable" },
        },
      },
    });

    expect(screen.getByText("LONG")).toBeTruthy();
    expect(screen.queryByText("Coin subscription coverage is Unknown.")).toBeNull();
  });
});
