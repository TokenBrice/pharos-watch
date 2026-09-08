// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeHealthyHealthResponse } from "@/test-utils/status-fixtures";
import { PublicServiceSummarySection } from "../public-service-summary-section";

describe("PublicServiceSummarySection", () => {
  it("keeps telegram queue warnings visible without inventing impacted surfaces", () => {
    render(
      <PublicServiceSummarySection
        healthData={{
          ...makeHealthyHealthResponse(),
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
        }}
      />,
    );
    expect(screen.getByText("Alert Queue")).toBeTruthy();
    expect(screen.getByText("2 alerts pending delivery")).toBeTruthy();
    expect(screen.getByText("No current public surface impact flags are active beyond the hero summary.")).toBeTruthy();
  });

  it("surfaces degraded blacklist ingestion in both summary and impact cards", () => {
    render(
      <PublicServiceSummarySection
        healthData={{
          ...makeHealthyHealthResponse(),
          blacklist: {
            totalEvents: 40,
            missingAmounts: 8,
            recentMissingAmounts: 4,
            recentWindowSec: 86_400,
            missingRatio: 0.2,
          },
        }}
      />,
    );

    expect(screen.getByText("Blacklist Gaps")).toBeTruthy();
    expect(screen.getByText("Blacklist risk context")).toBeTruthy();
    expect(screen.getAllByText("Missing Amounts").length).toBeGreaterThan(0);
  });

  it("omits the hourly mint/burn rollup when no rollup has been recorded", () => {
    // The shared healthy baseline records no hourly rollup (latestHourlyTs: null).
    render(<PublicServiceSummarySection healthData={makeHealthyHealthResponse()} />);

    expect(screen.getByText("Last Successful Sync")).toBeTruthy();
    expect(screen.queryByText("Latest Hourly Rollup")).toBeNull();
  });
});
