// @vitest-environment jsdom

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DatasetFreshnessTable } from "@/components/status/dataset-freshness-table";
import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { getDatasetCadenceSec, STATUS_DATASET_FRESHNESS } from "@shared/lib/status-dataset-freshness";
import type { StatusResponse } from "@shared/types";

const NOW = 1_800_000_000;
const FRESHNESS: StatusResponse["datasetFreshness"] = {
  stablecoins: NOW, blacklist: NOW, mintBurn: NOW, supply: NOW,
  safetyGrades: NOW, yield: NOW, depegs: NOW, dews: NOW, digest: NOW,
};

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
      const band = within(row).getByText(/^(on time|aging|late|unavailable|unknown)$/).textContent;
      // Grace basis column stays 2x cadence for every band.
      expect(within(row).getByText("12h")).toBeTruthy();
      return band;
    };

    expect(bandForAge(172_800)).toBe("on time");
    expect(bandForAge(172_801)).toBe("aging");
    expect(bandForAge(259_200)).toBe("aging");
    expect(bandForAge(259_201)).toBe("late");
    expect(bandForAge(null)).toBe("unavailable");
  });

  it("binds the live Safety publication to its half-hourly producer, not the daily history writer", () => {
    const keys = Object.keys(FRESHNESS);
    expect(Object.keys(STATUS_DATASET_FRESHNESS).sort()).toEqual(keys.sort());
    for (const descriptor of Object.values(STATUS_DATASET_FRESHNESS)) {
      expect(descriptor.owners.length).toBeGreaterThan(0);
      for (const owner of [...descriptor.owners, ...(descriptor.cadenceOwners ?? [])]) {
        expect(getCronJobMeta(owner)).toBeDefined();
      }
    }
    expect(getDatasetCadenceSec("safetyGrades")).toBe(1800);
    expect(STATUS_DATASET_FRESHNESS.safetyGrades.owners).toEqual(["compute-safety-score-v9"]);
    expect(getCronJobMeta("snapshot-safety-grade-history")?.intervalSec).toBe(86400);
    const { container } = render(<DatasetFreshnessTable nowSeconds={NOW}
      datasetFreshness={{ ...FRESHNESS, safetyGrades: NOW - 2 * 86400 }} />);
    const row = within(container).getByText("Safety Score publication").closest("tr")!;
    expect(within(row).getByText("late")).toBeTruthy();
    expect(row.cells[3].textContent).toBe("30m");
    expect(row.cells[4].textContent).toBe("1h");
    expect(row.cells[5].textContent).toBe(getCronJobMeta("compute-safety-score-v9")?.label);
  });

  it.each([NOW + 1, NOW + 61, Number.NaN, Number.POSITIVE_INFINITY])(
    "renders an invalid publication clock %s as unavailable, never zero-age on time", (clock) => {
      const { container } = render(<DatasetFreshnessTable nowSeconds={NOW}
        datasetFreshness={{ ...FRESHNESS, safetyGrades: clock }} />);
      const row = within(container).getByText("Safety Score publication").closest("tr")!;
      expect(within(row).getByText("unavailable")).toBeTruthy();
      expect(within(row).queryByText("on time")).toBeNull();
      expect(row.cells[2].textContent).toBe("—");
    },
  );

  it("preserves an unavailable reason even beside a retained numeric clock", () => {
    const { container } = render(<DatasetFreshnessTable nowSeconds={NOW}
      datasetFreshness={{ ...FRESHNESS, unavailableReasons: { safetyGrades: "future-timestamp" } }} />);
    const row = within(container).getByText("Safety Score publication").closest("tr")!;
    expect(within(row).getByText("unavailable")).toBeTruthy();
    expect(row.cells[2].textContent).toBe("—");
    expect(row.cells[6].title).toBe("future-timestamp");
  });
});
