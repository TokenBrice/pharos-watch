// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramBotStats } from "../telegram-bot-stats";
import type { StatusResponse } from "@shared/types";

const LIFECYCLE_SNAPSHOT_AT = 1_771_856_400;

const telegramBot: NonNullable<StatusResponse["telegramBot"]> = {
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
  pendingDeliveries: 7,
  lastSubscriberActivityAt: 1_700_000_000,
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
  topStablecoins: [],
  oldestPendingDeliveryAgeSec: 240,
  pendingDeliveryBacklog: { due: 4, deferred: 2, expired: 1 },
  retryErrorClassCounts: { rate_limit: 5, auth_error: 1 },
  presetQueryFailures: 2,
  inactiveSubscribersCleanedThisWeek: 6,
  lifecycleSnapshot: {
    date: "2026-05-13",
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
    pendingDeliveries: 7,
  },
};

const dispatchCron: StatusResponse["crons"][string] = {
  lastRun: {
    startedAt: LIFECYCLE_SNAPSHOT_AT + 1_700,
    durationMs: 1_200,
    status: "ok",
    itemCount: 3,
    metadata: {
      perAlertType: {
        dews: { sent: 3, enqueued: 1, failed: 0, blocked: 0, firstSendLatencyMs: 240 },
        depeg: { sent: 1, enqueued: 2, failed: 1, blocked: 0, firstSendLatencyMs: null },
      },
    },
  },
  recentRuns: [],
  expectedIntervalSec: 300,
  healthy: true,
};

afterEach(() => {
  cleanup();
});

describe("TelegramBotStats", () => {
  it("surfaces pending backlog and retry telemetry for operators", () => {
    render(<TelegramBotStats telegramBot={telegramBot} nowSeconds={LIFECYCLE_SNAPSHOT_AT + 1_800} />);

    expect(screen.getByText("Pending delivery telemetry")).toBeTruthy();
    expect(screen.getByText("Oldest pending age")).toBeTruthy();
    expect(screen.getByText("Backlog due")).toBeTruthy();
    expect(screen.getByText("Backlog deferred")).toBeTruthy();
    expect(screen.getByText("Backlog expired")).toBeTruthy();
    expect(screen.getByText("Preset query failures")).toBeTruthy();
    expect(screen.getByText("Preset followers")).toBeTruthy();
    expect(screen.getByText("Lifecycle snapshot")).toBeTruthy();
    expect(screen.getByText("Snapshot captured")).toBeTruthy();
    expect(screen.getByText(`${new Date(LIFECYCLE_SNAPSHOT_AT * 1000).toLocaleString()} (30m ago)`)).toBeTruthy();
    expect(screen.getByText("Preset-implied follows")).toBeTruthy();
    expect(screen.getByText("Inactive cleaned 7d")).toBeTruthy();
    expect(screen.getByText("Pending retry classes")).toBeTruthy();
    expect(screen.getByText("rate_limit")).toBeTruthy();
    expect(screen.getByText("auth_error")).toBeTruthy();
    expect(screen.queryByText(/snapshot stale/i)).toBeNull();
  });

  it("shows a lifecycle snapshot staleness chip after two refresh cadences", () => {
    render(<TelegramBotStats telegramBot={telegramBot} nowSeconds={LIFECYCLE_SNAPSHOT_AT + 1_861} />);

    expect(screen.getByText("snapshot stale · 31m old")).toBeTruthy();
  });

  it("shows field-level partial telemetry diagnostics for operators", () => {
    render(
      <TelegramBotStats
        telegramBot={{
          ...telegramBot,
          quality: {
            status: "partial",
            unavailableFields: ["pendingDeliveryBacklog"],
            errors: { pendingDeliveryBacklog: "no such table" },
          },
        }}
        nowSeconds={1_700_000_300}
      />,
    );

    expect(screen.getByText(/Telegram telemetry is partial: pendingDeliveryBacklog/i)).toBeTruthy();
    expect(screen.getByText(/no such table/i)).toBeTruthy();
  });

  it("constrains card grids and stacks long metric values on narrow screens", () => {
    render(<TelegramBotStats telegramBot={telegramBot} nowSeconds={LIFECYCLE_SNAPSHOT_AT + 1_800} />);

    expect(screen.getByTestId("telegram-summary-grid").className).toContain("sm:grid-cols-[repeat(2,minmax(0,1fr))]");
    expect(screen.getByTestId("telegram-detail-grid").className).toContain("xl:grid-cols-[repeat(3,minmax(0,1fr))]");

    const metricLabel = screen.getByText("Snapshot captured");
    const metricRow = metricLabel.parentElement;
    const metricValue = screen.getByText(`${new Date(LIFECYCLE_SNAPSHOT_AT * 1000).toLocaleString()} (30m ago)`);
    expect(metricRow?.className).toContain("grid-cols-1");
    expect(metricRow?.className).toContain("sm:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]");
    expect(metricValue.className).toContain("min-w-0");
    expect(metricValue.className).toContain("break-words");
  });

  it("uses a stacked mobile delivery list and a fixed-layout desktop table", () => {
    const { container } = render(
      <TelegramBotStats
        telegramBot={telegramBot}
        dispatchCron={dispatchCron}
        nowSeconds={LIFECYCLE_SNAPSHOT_AT + 1_800}
      />,
    );

    const mobileDelivery = screen.getByTestId("telegram-delivery-mobile");
    const desktopDelivery = screen.getByTestId("telegram-delivery-desktop");
    expect(mobileDelivery.className).toContain("sm:hidden");
    expect(mobileDelivery.querySelectorAll("dl")).toHaveLength(5);
    expect(mobileDelivery.textContent).toContain("First send latency");
    expect(desktopDelivery.className).toContain("overflow-x-auto");
    expect(desktopDelivery.querySelector("table")?.className).toContain("table-fixed");
    expect(desktopDelivery.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(container.innerHTML).not.toContain("grid-cols-[6rem_repeat(4,minmax(0,1fr))");
  });
});
