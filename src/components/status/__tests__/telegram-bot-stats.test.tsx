// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramBotStats } from "../telegram-bot-stats";
import type { StatusResponse } from "@shared/types";

const telegramBot: NonNullable<StatusResponse["telegramBot"]> = {
  totalChats: 10,
  alertEnabledChats: 8,
  deliverableChats: 8,
  subscribedChats: 6,
  emptyAlertChats: 1,
  mutedChatsWithSubscriptions: 2,
  totalSubscriptions: 15,
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
    allTypes: 1,
  },
  topStablecoins: [],
  oldestPendingDeliveryAgeSec: 240,
  pendingDeliveryBacklog: { due: 4, deferred: 2, expired: 1 },
  retryErrorClassCounts: { rate_limit: 5, auth_error: 1 },
  presetQueryFailures: 2,
  inactiveSubscribersCleanedThisWeek: 6,
};

afterEach(() => {
  cleanup();
});

describe("TelegramBotStats", () => {
  it("surfaces pending backlog and retry telemetry for operators", () => {
    render(<TelegramBotStats telegramBot={telegramBot} nowSeconds={1_700_000_300} />);

    expect(screen.getByText("Pending delivery telemetry")).toBeTruthy();
    expect(screen.getByText("Oldest pending age")).toBeTruthy();
    expect(screen.getByText("Backlog due")).toBeTruthy();
    expect(screen.getByText("Backlog deferred")).toBeTruthy();
    expect(screen.getByText("Backlog expired")).toBeTruthy();
    expect(screen.getByText("Preset query failures")).toBeTruthy();
    expect(screen.getByText("Inactive cleaned 7d")).toBeTruthy();
    expect(screen.getByText("Pending retry classes")).toBeTruthy();
    expect(screen.getByText("rate_limit")).toBeTruthy();
    expect(screen.getByText("auth_error")).toBeTruthy();
  });
});
