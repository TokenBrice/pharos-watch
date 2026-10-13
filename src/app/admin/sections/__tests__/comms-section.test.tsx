// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeCompleteTelegramBotStatus, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { CommsSection } from "../comms-section";

function makeCompleteCommsStatus() {
  const data = makeHealthyStatusResponse();
  data.telegramBot = makeCompleteTelegramBotStatus({
    explicitCoinSubscriptions: 15,
    presetImpliedCoinSubscriptions: 0,
    activePresetFollowers: 0,
  });
  data.crons["dispatch-telegram-alerts"] = {
    ...data.crons["dispatch-telegram-alerts"]!,
    lastRun: {
      startedAt: data.timestamp - 60,
      durationMs: 200,
      status: "ok",
      itemCount: 0,
      metadata: {
        freshRetryQueued: 0,
        pendingRetryQueued: 0,
        freshPermanentFailures: 0,
        pendingDroppedPermanentFailure: 0,
        pendingDroppedMaxAttemptsFallback: 0,
        pendingRateLimited: false,
        safetyAlertsSuppressed: false,
        reserveAlertsSuppressed: false,
      },
    },
  };
  return data;
}

afterEach(cleanup);

describe("CommsSection", () => {
  it("summarizes delivery evidence before rendering the focused workbench", () => {
    render(<CommsSection data={makeCompleteCommsStatus()} />);

    expect(screen.getByRole("heading", { level: 1, name: "Comms" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Delivery Operations" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Audience Coverage" })).toBeTruthy();
    expect(screen.getByText("Telegram delivery operations and audience coverage.")).toBeTruthy();
    expect(screen.getByText("Delivery").nextElementSibling?.textContent).toBe("Healthy");
    // A4: an empty queue has no oldest item; that is not missing telemetry.
    expect(screen.getByText("Oldest backlog").nextElementSibling?.textContent).toBe("No backlog");
    expect(screen.getAllByText("Permanent failures")[0].nextElementSibling?.textContent).toBe("0");
    // C7: the watchdog cron is cross-linked and explained as a separate signal.
    const watchdog = screen.getByRole("link", { name: "Telegram degradation watchdog cron" });
    expect(watchdog.getAttribute("href")).toMatch(/^\/admin\/crons\/?\?job=telegram-degradation-watchdog$/);
    expect(screen.getAllByText("Latest dispatch")[0].nextElementSibling?.textContent).toBe("Succeeded");
  });

  it("does not manufacture healthy Comms state when section and dispatch telemetry are unavailable", () => {
    const data = makeHealthyStatusResponse();
    data.telegramBot = null;
    delete data.crons["dispatch-telegram-alerts"];
    data.sectionErrors.telegramBot = { code: "telegram_query_failed", message: "Telegram query unavailable" };

    render(<CommsSection data={data} />);

    expect(screen.getByText("Delivery").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Oldest backlog").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getAllByText("Permanent failures")[0].nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getAllByText("Latest dispatch")[0].nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Telegram query unavailable")).toBeTruthy();
  });
});
