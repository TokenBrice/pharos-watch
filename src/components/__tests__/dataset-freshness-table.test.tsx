// @vitest-environment jsdom

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DatasetFreshnessTable } from "@/components/status/dataset-freshness-table";

describe("DatasetFreshnessTable", () => {
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
