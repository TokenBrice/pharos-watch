// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeActivePriceCoverage, makeHealthyHealthResponse, makeMissingActiveAsset } from "@/test-utils/status-fixtures";
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

  it("does not claim there are no impact flags while health warnings are active", () => {
    render(
      <PublicServiceSummarySection
        healthData={{
          ...makeHealthyHealthResponse(),
          status: "degraded",
          warnings: ["cache-quality-degraded: yield-data:producer-degraded-since-last-clean-run"],
        }}
      />,
    );

    expect(screen.queryByText("No current public surface impact flags are active beyond the hero summary.")).toBeNull();
    expect(
      screen.getByText("Health warnings are summarized above. No additional surfaces meet the impact thresholds tracked in this section."),
    ).toBeTruthy();
  });

  it("reports acknowledged price gaps as informational review text, not as an impacted surface", () => {
    render(
      <PublicServiceSummarySection
        healthData={{
          ...makeHealthyHealthResponse(),
          activePriceCoverage: makeActivePriceCoverage([
            makeMissingActiveAsset({
              stablecoinId: "wusd-worldwide",
              symbol: "WUSD",
              alertEligible: false,
              consecutiveMissingGenerations: 2000,
              acknowledgedGap: {
                owner: "ops",
                reason: "No admissible quote on any lane; issuer data requested.",
                sources: ["https://example.com/review"],
                reviewedAt: 1_790_121_600,
                expiresAt: 1_792_713_600,
              },
            }),
          ]),
        }}
      />,
    );

    expect(
      screen.getByText("1 acknowledged price gap under review; next review expires 2026-10-23 (UTC). Prices remain unavailable and gaps re-alert when their reviews expire."),
    ).toBeTruthy();
    expect(screen.queryByText("Impacted Surfaces")).toBeNull();
  });
});
