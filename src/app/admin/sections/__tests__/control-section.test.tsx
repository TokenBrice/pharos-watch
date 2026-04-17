// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
});

vi.mock("@/components/status/admin-actions-panel", () => ({
  AdminActionsPanel: ({ showRecommendations }: { showRecommendations: boolean }) => (
    <div data-testid="admin-actions">recs:{String(showRecommendations)}</div>
  ),
}));

vi.mock("@/components/status/api-keys-panel", () => ({
  ApiKeysPanel: () => <div data-testid="api-keys-panel">api keys</div>,
}));

vi.mock("@/components/status/telegram-bot-stats", () => ({
  TelegramBotStats: ({
    telegramBot,
  }: {
    telegramBot: { deliverableChats: number; pendingDeliveries: number } | null;
  }) => (
    <div data-testid="telegram-bot-stats">
      {telegramBot ? `chats:${telegramBot.deliverableChats} pending:${telegramBot.pendingDeliveries}` : "no-bot"}
    </div>
  ),
}));

import { ControlSection } from "@/app/admin/sections/control-section";
import type { StatusActionRecommendation } from "@/lib/status/action-recommendations";
import { degraded, makeHealthyStatusResponse } from "@/app/admin/__tests__/fixtures/status-response";

function makeRecommendation(path: string, label: string): StatusActionRecommendation {
  return {
    action: {
      label,
      path,
      confirm: `Trigger ${label}?`,
      destructive: false,
      method: "POST",
      acceptsStablecoinFilter: false,
    },
    reason: `${label} lane needs attention`,
    severity: "warning",
    source: "cause",
    sourceKey: `cause:${path}`,
  };
}

describe("ControlSection", () => {
  it("renders the healthy summary and Telegram stats panel", () => {
    const data = makeHealthyStatusResponse();

    render(
      <ControlSection
        data={data}
        handleRefresh={vi.fn()}
        recommendedActions={[]}
        isTelegramOpen={false}
        setIsTelegramOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("Manual response")).toBeTruthy();
    // Suggested actions: 0, Alert-ready chats: 8, Pending deliveries: 0
    const suggested = screen.getByText("Suggested Actions").parentElement;
    expect(suggested?.textContent).toContain("0");
    const alertReady = screen.getByText("Alert-ready Chats").parentElement;
    expect(alertReady?.textContent).toContain("8");
    const pending = screen.getByText("Pending Deliveries").parentElement;
    expect(pending?.textContent).toContain("0");
    // Nested mocked telegram stats render
    expect(screen.getByTestId("telegram-bot-stats").textContent).toContain("chats:8 pending:0");
  });

  it("reflects recommended-action counts and pending deliveries when degraded", () => {
    const data = degraded(makeHealthyStatusResponse(), {
      telegramBot: {
        ...makeHealthyStatusResponse().telegramBot!,
        deliverableChats: 4,
        pendingDeliveries: 12,
      },
    });
    const recommendations = [
      makeRecommendation("/api/backfill-cg-prices", "Backfill prices"),
      makeRecommendation("/api/reset-blacklist-sync", "Reset blacklist"),
    ];

    render(
      <ControlSection
        data={data}
        handleRefresh={vi.fn()}
        recommendedActions={recommendations}
        isTelegramOpen={false}
        setIsTelegramOpen={vi.fn()}
      />,
    );

    const suggested = screen.getByText("Suggested Actions").parentElement;
    expect(suggested?.textContent).toContain("2");
    const pending = screen.getByText("Pending Deliveries").parentElement;
    expect(pending?.textContent).toContain("12");
    expect(screen.getByTestId("telegram-bot-stats").textContent).toContain("chats:4 pending:12");
  });

  it("opens the Telegram details block when isTelegramOpen is true", () => {
    const data = makeHealthyStatusResponse();

    render(
      <ControlSection
        data={data}
        handleRefresh={vi.fn()}
        recommendedActions={[]}
        isTelegramOpen={true}
        setIsTelegramOpen={vi.fn()}
      />,
    );

    const details = screen.getByText("Telegram delivery telemetry").closest("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(true);
  });
});
