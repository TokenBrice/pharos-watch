// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildCemeteryStats, type CemeteryStats } from "@/lib/cemetery-stats";
import { CemeteryKeyFacts } from "../cemetery/cemetery-key-facts";

// vi.mock factories are hoisted above the imports, so the helper loads lazily inside it.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const DATASET_META = { schemaVersion: "1.1", sourceChecksumShort: "55a1b478" };

function makeStats(overrides: Partial<CemeteryStats> = {}, keyFacts: Partial<CemeteryStats["keyFacts"]> = {}): CemeteryStats {
  const base = buildCemeteryStats([
    { id: "a", name: "Coin A", symbol: "AAA", causeOfDeath: "abandoned", deathDate: "2026-08-27", peakMcap: 1e6, pegCurrency: "USD" },
    { id: "b", name: "Coin B", symbol: "BBB", causeOfDeath: "regulatory", deathDate: "2024-03", peakMcap: 2e6, pegCurrency: "USD" },
  ]);
  return {
    ...base,
    asOf: { date: "2026-08-27", year: 2026, month: 8, day: 27, precision: "day", label: "Aug 27, 2026", monthLabel: "Aug 2026" },
    updatedAt: "2026-09-23",
    keyFacts: {
      trailing12: { startMonth: "2025-09", endMonth: "2026-08", months: 12, total: 39, tracked: 20, curated: 19 },
      prior12: { startMonth: "2024-09", endMonth: "2025-08", months: 12, total: 20, tracked: 2, curated: 18 },
      curatedTrend: { trailing: 19, prior: 18, direction: "flat" },
      topTwo: {
        ids: ["busd", "ust"],
        symbols: ["BUSD", "UST"],
        names: ["Binance USD", "TerraUSD"],
        peaks: [23.5e9, 18.7e9],
        sum: 42.2e9,
        share: 0.711,
        recordedTotal: 59.4e9,
        knownCount: 103,
        total: 113,
      },
      medianPeak: { value: 48.8e6, knownCount: 103 },
      atLeastOneBillionCount: 5,
      trackedCount: 24,
      ...keyFacts,
    },
    ...overrides,
  };
}

function cellFor(label: string): HTMLElement {
  const cell = screen.getByText(label).parentElement;
  if (!cell) throw new Error(`no cell for ${label}`);
  return cell;
}

describe("CemeteryKeyFacts", () => {
  it("renders the four figures and sub-lines from the stats", () => {
    const { container } = render(<CemeteryKeyFacts stats={makeStats()} datasetMeta={DATASET_META} />);

    expect(screen.getByRole("heading", { level: 2, name: "Key facts" })).toBeTruthy();
    expect(Array.from(container.querySelectorAll("dt"), (dt) => dt.textContent)).toEqual([
      "12 months to Aug 2026",
      "Held by two coins",
      "Median peak",
      "Tracked before death",
    ]);

    const trailing = within(cellFor("12 months to Aug 2026"));
    expect(trailing.getByText("39")).toBeTruthy();
    expect(
      trailing.getByText("20 of these were coins Pharos tracked live (2 in the prior 12 months). Curated records: 19 vs 18."),
    ).toBeTruthy();

    const topTwo = within(cellFor("Held by two coins"));
    expect(topTwo.getByText("71.1%")).toBeTruthy();
    expect(topTwo.getByText("BUSD and UST: $42.2B of $59.4B combined peak (103 of 113 recorded).")).toBeTruthy();

    const median = within(cellFor("Median peak"));
    expect(median.getByText("$48.8M")).toBeTruthy();
    expect(median.getByText("Half of the recorded deaths peaked below this. 5 peaked at $1B or more.")).toBeTruthy();

    const tracked = within(cellFor("Tracked before death"));
    expect(tracked.getByText("24")).toBeTruthy();
    expect(
      tracked.getByRole("link", { name: "Show the 24 tracked-archive records in the register" }).getAttribute("href"),
    ).toBe("/cemetery/?record=tracked#register");
  });

  it("hides the top-two cell when fewer than two peaks are recorded", () => {
    const { container } = render(<CemeteryKeyFacts stats={makeStats({}, { topTwo: null })} datasetMeta={DATASET_META} />);

    expect(screen.queryByText("Held by two coins")).toBeNull();
    expect(container.querySelectorAll("dt")).toHaveLength(3);
  });

  it("prints a missing median as not recorded, never as zero", () => {
    render(<CemeteryKeyFacts stats={makeStats({}, { medianPeak: { value: null, knownCount: 0 } })} datasetMeta={DATASET_META} />);

    const median = cellFor("Median peak");
    expect(median.textContent).toContain("not recorded");
    expect(median.textContent).not.toContain("$0");
  });

  it("prints the freshness rail without a coverage claim", () => {
    const { container } = render(<CemeteryKeyFacts stats={makeStats()} datasetMeta={DATASET_META} />);

    const rail = container.querySelector("#key-facts p");
    expect(rail?.textContent).toBe(
      "Updated Sep 23, 2026 · Latest recorded death Aug 27, 2026 · Dataset schema 1.1 · checksum 55a1b478",
    );
    expect(container.textContent).not.toMatch(/through/i);
  });

  it("omits the Updated clause when no record carries a recordedAt", () => {
    const { container } = render(<CemeteryKeyFacts stats={makeStats({ updatedAt: null })} datasetMeta={DATASET_META} />);

    const rail = container.querySelector("#key-facts p");
    expect(rail?.textContent).toBe("Latest recorded death Aug 27, 2026 · Dataset schema 1.1 · checksum 55a1b478");
    expect(container.textContent).not.toMatch(/through/i);
  });
});
