// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { CommsSection } from "../comms-section";

function makeCompleteCommsStatus() {
  const data = makeHealthyStatusResponse();
  data.telegramBot = {
    ...data.telegramBot!,
    explicitCoinSubscriptions: 15,
    presetImpliedCoinSubscriptions: 0,
    activePresetFollowers: 0,
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
    expect(screen.getByText(/missing evidence kept explicitly Unknown/i)).toBeTruthy();
    expect(screen.getByText("Delivery").nextElementSibling?.textContent).toBe("Healthy");
    expect(screen.getByText("Oldest Backlog").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Permanent Failures").nextElementSibling?.textContent).toBe("0");
    expect(screen.getByText("Latest Dispatch").nextElementSibling?.textContent).toBe("ok");
  });

  it("does not manufacture healthy Comms state when section and dispatch telemetry are unavailable", () => {
    const data = makeHealthyStatusResponse();
    data.telegramBot = null;
    delete data.crons["dispatch-telegram-alerts"];
    data.sectionErrors.telegramBot = { code: "telegram_query_failed", message: "Telegram query unavailable" };

    render(<CommsSection data={data} />);

    expect(screen.getByText("Delivery").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Permanent Failures").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Latest Dispatch").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Telegram query unavailable")).toBeTruthy();
  });
});
