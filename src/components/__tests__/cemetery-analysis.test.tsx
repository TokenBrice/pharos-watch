// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CAUSE_META, CAUSE_ORDER } from "@shared/lib/cause-of-death";
import { formatDeathDate } from "@shared/lib/format";
import { buildCemeteryStats, formatCemeteryPeak, type CemeteryStatsInput } from "@/lib/cemetery-stats";
import { CemeteryAnalysis } from "../cemetery/cemetery-analysis";

const selection = vi.hoisted(() => ({ revealRecord: vi.fn() }));

vi.mock("@/components/cemetery/cemetery-selection-context", () => ({
  useCemeterySelection: () => ({ revealRecord: selection.revealRecord }),
}));

// 2021 · 2022 empty · 2023 · 2024 partial (data stops in March). One record without a peak (REG1).
const ENTRIES: CemeteryStatsInput[] = [
  { id: "alg-1", name: "Algorithmic One", symbol: "ALG1", causeOfDeath: "algorithmic-failure", deathDate: "2021-05", peakMcap: 1e9, pegCurrency: "USD" },
  { id: "cpf-1", name: "Counterparty One", symbol: "CPF1", causeOfDeath: "counterparty-failure", deathDate: "2023-02-13", peakMcap: 20e6, pegCurrency: "USD" },
  { id: "reg-1", name: "Regulatory One", symbol: "REG1", causeOfDeath: "regulatory", deathDate: "2023-07", peakMcap: null, pegCurrency: "USD" },
  { id: "abn-1", name: "Abandoned One", symbol: "ABN1", causeOfDeath: "abandoned", deathDate: "2024-01", peakMcap: 5e6, pegCurrency: "USD", archivedDataAvailable: true },
  { id: "liq-1", name: "Liquidity One", symbol: "LIQ1", causeOfDeath: "liquidity-drain", deathDate: "2024-03", peakMcap: 50e6, pegCurrency: "USD" },
];

function renderAnalysis() {
  return render(<CemeteryAnalysis stats={buildCemeteryStats(ENTRIES)} />);
}

function tables(container: HTMLElement): HTMLTableElement[] {
  return Array.from(container.querySelectorAll("table"));
}

function rowHeaders(table: HTMLTableElement): string[] {
  return Array.from(table.querySelectorAll("tbody th")).map((cell) => cell.textContent ?? "");
}

function dotName(entry: CemeteryStatsInput): string {
  return `${entry.name} (${entry.symbol}), ${formatCemeteryPeak(entry.peakMcap as number)}, ${formatDeathDate(entry.deathDate)}`;
}

function dots(): HTMLElement[] {
  return within(screen.getByRole("group", { name: /^Peak market cap by cause/ })).getAllByRole("button");
}

describe("CemeteryAnalysis", () => {
  it("exposes chart B as a labelled image and chart C as a labelled interactive group", () => {
    renderAnalysis();

    const yearChart = screen.getByRole("img", { name: /^Documented deaths per year by cause, 2021 to 2024/ });
    expect(yearChart.tagName.toLowerCase()).toBe("svg");
    expect(yearChart.getAttribute("aria-label")).toContain("2022: none recorded");
    expect(yearChart.getAttribute("aria-label")).toContain("2024: 2 through Mar 2024");

    const peakChart = screen.getByRole("group", { name: /^Peak market cap by cause on a log scale: 4 deaths/ });
    expect(peakChart.tagName.toLowerCase()).toBe("svg");
  });

  it("renders a visible data table per chart with one row per year and per cause", () => {
    const { container } = renderAnalysis();
    const [yearTable, peakTable] = tables(container);
    expect(tables(container)).toHaveLength(2);
    for (const table of [yearTable, peakTable]) expect(table.closest("details")?.querySelector("summary")?.textContent).toBe("Data table");

    expect(rowHeaders(yearTable)).toEqual(["2021", "2022", "2023", "2024 (through Mar 2024)"]);
    const yearRows = Array.from(yearTable.querySelectorAll("tbody tr")).map((row) =>
      Array.from(row.children).map((cell) => cell.textContent),
    );
    // Year, Total, five causes in CAUSE_ORDER, Tracked archive, Median peak.
    expect(yearRows[1]).toEqual(["2022", "0", "0", "0", "0", "0", "0", "0", "no records"]);
    expect(yearRows[2]).toEqual(["2023", "2", "0", "1", "0", "0", "1", "0", formatCemeteryPeak(20e6)]);
    expect(yearRows[3].slice(-2)).toEqual(["1", formatCemeteryPeak(27.5e6)]);

    expect(rowHeaders(peakTable)).toEqual(CAUSE_ORDER.map((cause) => CAUSE_META[cause].label));
    const regulatory = Array.from(peakTable.querySelectorAll("tbody tr")).at(-1);
    expect(Array.from(regulatory?.children ?? []).map((cell) => cell.textContent)).toEqual([
      "Regulatory",
      "0",
      "1",
      "not recorded",
      "not recorded",
    ]);
  });

  it("plots only recorded peaks in chart C, one dot each, and footnotes the rest", () => {
    const { container } = renderAnalysis();

    const recorded = ENTRIES.filter((entry) => entry.peakMcap != null);
    expect(dots().map((dot) => dot.getAttribute("aria-label")).sort()).toEqual(recorded.map(dotName).sort());
    expect(dots().some((dot) => dot.getAttribute("aria-label")?.includes("REG1"))).toBe(false);
    expect(container.textContent).toContain("1 record has no recorded peak and is not plotted.");
  });
});
