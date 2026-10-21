// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PublicStatusComponent } from "@shared/types";
import { PUBLIC_STATUS_COMPONENT_IDS } from "@shared/types/status";
import { PublicServiceSummarySection } from "../public-service-summary-section";

const NOW = 1_790_000_000;

function components(overrides: Partial<Record<string, Partial<PublicStatusComponent>>> = {}): PublicStatusComponent[] {
  return PUBLIC_STATUS_COMPONENT_IDS.map((id) => ({
    id, state: "operational", summary: "", reasons: [], ageSeconds: null, budget: null, since: null, ...overrides[id],
  }));
}

describe("PublicServiceSummarySection", () => {
  it("renders the dedicated Safety Scores row with its scope and held reason", () => {
    render(<PublicServiceSummarySection
      components={components({
        "safety-scores": {
          state: "degraded",
          summary: "Safety Score publication is held.",
          reasons: ["safety-score-publication-held:redemption-stale"],
        },
      })}
      dayCells={null} historyState="loading" historyDays={30} nowSec={NOW} publicHistoryStartedAt={null}
    />);
    const row = within(screen.getByTestId("public-component-safety-scores"));
    expect(row.getByText("Safety Scores")).toBeTruthy();
    expect(row.getByText("Pharos Safety Scores and their publication.")).toBeTruthy();
    expect(row.getByText("Degraded")).toBeTruthy();
    expect(row.getByText("safety-score-publication-held:redemption-stale")).toBeTruthy();
    expect(screen.getByTestId("public-component-risk-signals")).toBeTruthy();
  });

  it("renders an operational component notice without presenting healthy-state age as incident duration", () => {
    render(<PublicServiceSummarySection
      components={components({
        "mint-burn": {
          summary: "Critical mint and burn data is fresh. The latest run reported an execution notice.",
          reasons: ["mint-burn-run-degraded"], since: NOW - 3600,
        },
      })}
      dayCells={null} historyState="loading" historyDays={30} nowSec={NOW} publicHistoryStartedAt={null}
    />);
    const row = within(screen.getByTestId("public-component-mint-burn"));
    expect(row.getByText("Operational")).toBeTruthy();
    expect(row.getByText(/Critical mint and burn data is fresh/)).toBeTruthy();
    expect(row.getByText("mint-burn-run-degraded")).toBeTruthy();
    expect(row.queryByText(/^For /)).toBeNull();
  });

  it("names the summary, budget and machine reason of a non-operational component (R3/R4)", () => {
    render(<PublicServiceSummarySection
      components={components({
        yield: {
          state: "delayed", summary: "Yield rankings last updated 2h ago.", reasons: ["cache-stale:yield-data:delayed"],
          ageSeconds: 7200, budget: { delayedAfterSec: 3600, degradedAfterSec: 10_800, outageAfterSec: 21_600 }, since: NOW - 1800,
        },
      })}
      dayCells={null} historyState="error" historyDays={30} nowSec={NOW} publicHistoryStartedAt={null}
    />);

    const row = within(screen.getByTestId("public-component-yield"));
    expect(row.getByText("Delayed")).toBeTruthy();
    expect(row.getByText("Yield rankings last updated 2h ago.")).toBeTruthy();
    expect(row.getByText("Delayed after 1h, degraded after 3h, outage after 6h without an update.")).toBeTruthy();
    expect(row.getByText("cache-stale:yield-data:delayed")).toBeTruthy();
    // A failed history read shows no bars rather than an empty (healthy-looking) runway.
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText(/Component history could not be loaded/)).toBeTruthy();
  });

  it("states when component history began inside the window", () => {
    const cells = Object.fromEntries(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, [
      { date: "2026-10-12", state: "no-data" as const }, { date: "2026-10-13", state: "operational" as const },
    ]])) as never;
    render(<PublicServiceSummarySection components={components()} dayCells={cells} historyState="ready"
      historyDays={30} nowSec={NOW} publicHistoryStartedAt={NOW - 3600} footnote="Two price gaps are under review." />);

    expect(screen.getAllByRole("img")).toHaveLength(PUBLIC_STATUS_COMPONENT_IDS.length);
    expect(screen.getByText(/Component history began/)).toBeTruthy();
    expect(screen.getByText("Two price gaps are under review.")).toBeTruthy();
  });
});
