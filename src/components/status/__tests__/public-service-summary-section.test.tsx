// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthResponse } from "@shared/types";
import { PublicServiceSummarySection } from "../public-service-summary-section";

afterEach(() => {
  cleanup();
});

function makeHealthResponse(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: "healthy",
    timestamp: 1_712_345_678,
    warnings: [],
    caches: {},
    blacklist: {
      totalEvents: 100,
      missingAmounts: 0,
      recentMissingAmounts: 0,
      recentWindowSec: 86_400,
      missingRatio: 0,
    },
    mintBurn: {
      totalEvents: 10,
      latestEventTs: 1_712_345_000,
      latestHourlyTs: 1_712_345_200,
      freshnessAgeSec: 60,
      majorStaleCount: 0,
      staleMajorSymbols: [],
      sync: {
        lastSuccessfulSyncAt: 1_712_345_100,
        freshnessStatus: "fresh",
        warning: null,
        criticalLaneHealthy: true,
      },
    },
    circuits: {},
    telegramSummary: {
      totalChats: 12,
      pendingDeliveries: 2,
      lastDispatchAt: 1_712_345_500,
      lastDispatchStatus: "ok",
      safetyAlertSourceState: "ok",
      safetyAlertSourceAgeSeconds: 30,
      safetyAlertsSuppressed: false,
      safetyAlertSourceGeneration: "v1",
    },
    ...overrides,
  };
}

describe("PublicServiceSummarySection", () => {
  it("keeps telegram queue warnings visible without inventing impacted surfaces", () => {
    render(<PublicServiceSummarySection healthData={makeHealthResponse()} />);

    expect(screen.getByText("Alert Queue")).toBeTruthy();
    expect(screen.getByText("2 alerts pending delivery")).toBeTruthy();
    expect(screen.getByText("No current public surface impact flags are active beyond the hero summary.")).toBeTruthy();
  });

  it("surfaces degraded blacklist ingestion in both summary and impact cards", () => {
    render(
      <PublicServiceSummarySection
        healthData={makeHealthResponse({
          blacklist: {
            totalEvents: 40,
            missingAmounts: 8,
            recentMissingAmounts: 4,
            recentWindowSec: 86_400,
            missingRatio: 0.2,
          },
        })}
      />,
    );

    expect(screen.getByText("Blacklist Gaps")).toBeTruthy();
    expect(screen.getByText("Blacklist risk context")).toBeTruthy();
    expect(screen.getAllByText("Missing Amounts").length).toBeGreaterThan(0);
  });

  it("omits the hourly mint/burn rollup when no rollup has been recorded", () => {
    render(
      <PublicServiceSummarySection
        healthData={makeHealthResponse({
          mintBurn: {
            ...makeHealthResponse().mintBurn,
            latestHourlyTs: null,
          },
        })}
      />,
    );

    expect(screen.getByText("Last Successful Sync")).toBeTruthy();
    expect(screen.queryByText("Latest Hourly Rollup")).toBeNull();
  });
});
