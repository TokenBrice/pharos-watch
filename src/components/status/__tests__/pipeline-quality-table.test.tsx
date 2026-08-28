// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PipelineQualityTable } from "../pipeline-quality-table";
import { buildPipelineQualityModel } from "@/lib/pipeline-workspace-model";
import { degraded, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";


describe("PipelineQualityTable", () => {
  it("renders the semantic threshold columns and keeps active depegs outside the breakpoint table", () => {
    const base = makeHealthyStatusResponse();
    const data = degraded(base, {
      dataQuality: {
        ...base.dataQuality,
        blacklistTotal: 100,
        onchainSupplyTrackedCoins: 5,
        activeDepegs: 2,
      },
    });

    render(<PipelineQualityTable model={buildPipelineQualityModel(data)} />);

    const table = screen.getByRole("table", { name: "Pipeline quality thresholds" });
    expect(within(table).getByRole("columnheader", { name: "Metric" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Eligible population" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Warning" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Stale" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Last change / trend" })).toBeTruthy();
    expect(within(table).getAllByText("Confidence floor is inactive below 10 monitored coins.")).toHaveLength(2);
    expect(within(table).queryByText("Active depegs")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Active depegs" }).textContent).toContain("2");
  });
});
