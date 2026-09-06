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
    expect(within(yieldRow as HTMLTableRowElement).getByText("1h")).toBeTruthy();
    expect(within(yieldRow as HTMLTableRowElement).getByText("2h")).toBeTruthy();
  });

  it("bands ages at the canonical 8x/12x cadence ratios with the grace basis column unchanged", () => {
    const nowSeconds = 2_000_000;
    // Blacklist sync publishes every 6h (21600s): aging starts above 8x cadence
    // (172800s), late above 12x cadence (259200s), and the displayed
    // grace basis column stays 2x cadence (12h).
    const bandForAge = (ageSeconds: number | null) => {
      const { container } = render(
        <DatasetFreshnessTable
          nowSeconds={nowSeconds}
          datasetFreshness={{
            stablecoins: nowSeconds - 60,
            blacklist: ageSeconds == null ? null : nowSeconds - ageSeconds,
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
      const row = within(container)
        .getAllByText("Blacklist sync")
        .find((element) => element.closest("td")?.cellIndex === 0)
        ?.closest("tr") as HTMLTableRowElement;
      const band = within(row).getByText(/^(on time|aging|late|missing|unknown)$/).textContent;
      // Grace basis column stays 2x cadence for every band.
      expect(within(row).getByText("12h")).toBeTruthy();
      return band;
    };

    expect(bandForAge(172_800)).toBe("on time");
    expect(bandForAge(172_801)).toBe("aging");
    expect(bandForAge(259_200)).toBe("aging");
    expect(bandForAge(259_201)).toBe("late");
    expect(bandForAge(null)).toBe("missing");
  });
});
