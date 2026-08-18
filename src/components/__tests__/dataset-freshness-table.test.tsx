// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DatasetFreshnessTable } from "@/components/status/dataset-freshness-table";

describe("DatasetFreshnessTable", () => {
  it("uses writer-oriented copy and schedule expectations", () => {
    const nowSeconds = 2_000_000;
    const getDomainRow = (label: string) =>
      screen
        .getAllByText(label)
        .find((element) => element.closest("td")?.cellIndex === 0)
        ?.closest("tr") ?? null;

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
        }}
      />,
    );

    expect(screen.getByText("Pipeline Freshness")).toBeTruthy();
    expect(screen.getByText(/last successful writer evaluation per domain/i)).toBeTruthy();
    expect(screen.getByText(/Cadence is the writer schedule/i)).toBeTruthy();
    const tableShell = screen.getByTestId("dataset-freshness-table");
    expect(tableShell.getAttribute("data-table-id")).toBe("dataset-freshness");
    expect(screen.getByRole("table", { name: /pipeline freshness/i })).toBeTruthy();

    const blacklistRow = getDomainRow("Blacklist sync");
    expect(blacklistRow).not.toBeNull();
    expect(within(blacklistRow as HTMLTableRowElement).getByText("6h")).toBeTruthy();
    expect(within(blacklistRow as HTMLTableRowElement).getByText("12h")).toBeTruthy();

    const dewsRow = getDomainRow("DEWS signals");
    expect(dewsRow).not.toBeNull();
    expect(within(dewsRow as HTMLTableRowElement).getByText("30m")).toBeTruthy();
    expect(within(dewsRow as HTMLTableRowElement).getByText("1h")).toBeTruthy();

    const yieldRow = getDomainRow("Yield data");
    expect(yieldRow).not.toBeNull();
    expect(within(yieldRow as HTMLTableRowElement).getByText("30m")).toBeTruthy();
    expect(within(yieldRow as HTMLTableRowElement).getByText("1h")).toBeTruthy();
  });
});
