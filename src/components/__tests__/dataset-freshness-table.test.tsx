// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DatasetFreshnessTable } from "@/components/status/dataset-freshness-table";

describe("DatasetFreshnessTable", () => {
  it("uses writer-oriented copy and discovery expectations", () => {
    const nowSeconds = 2_000_000;

    render(
      <DatasetFreshnessTable
        nowSeconds={nowSeconds}
        datasetFreshness={{
          stablecoins: nowSeconds - 60,
          blacklist: nowSeconds - 120,
          mintBurn: nowSeconds - 180,
          supply: nowSeconds - 86_400,
          safetyGrades: nowSeconds - 86_400,
          yield: nowSeconds - 300,
          depegs: nowSeconds - 120,
          dews: nowSeconds - 300,
          digest: nowSeconds - 86_400,
          discoveryCandidates: nowSeconds - 600,
        }}
      />,
    );

    expect(screen.getByText("Pipeline Freshness")).toBeTruthy();
    expect(screen.getByText(/last successful writer evaluation per domain/i)).toBeTruthy();

    const discoveryRow = screen.getByText("Coverage discovery").closest("tr");
    expect(discoveryRow).not.toBeNull();
    expect(within(discoveryRow as HTMLTableRowElement).getByText("2d")).toBeTruthy();
  });
});
