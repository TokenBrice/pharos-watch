// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenerToolbar } from "@/components/screener/screener-toolbar";
import { useJustEntered } from "@/hooks/use-just-entered";
import { SCREENER_FILTER_DEFAULTS, type ScreenerFilters } from "@/lib/screener-filters";
import { cleanupFrontendTest } from "@/test-utils/frontend";

function renderToolbar(
  filters: Partial<ScreenerFilters> = {},
  overrides: {
    activeFilterCount?: number;
    searchQuery?: string;
    onSearchChange?: (q: string) => void;
  } = {},
) {
  const onChange = vi.fn();
  const onSearchChange = overrides.onSearchChange ?? vi.fn();
  render(
    <ScreenerToolbar
      filters={{ ...SCREENER_FILTER_DEFAULTS, ...filters }}
      searchQuery={overrides.searchQuery ?? ""}
      onSearchChange={onSearchChange}
      matchingRows={1}
      totalRows={1}
      dataState="ready"
      activeFilterCount={overrides.activeFilterCount ?? 0}
      onChange={onChange}
      onReset={vi.fn()}
    />,
  );
  return { onChange, onSearchChange };
}

function setFloor(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(`${label} greater than or equal to`), {
    target: { value },
  });
}

afterEach(cleanupFrontendTest);

it.each<[string, string[], string[], number]>([
  ["removal", [], [], 250],
  ["unrelated array identity change", ["A"], ["A"], 150],
  ["new addition", ["A", "B"], ["B"], 250],
])("bounds chip entrance after %s", (_, next, expected, remaining) => {
  vi.useFakeTimers();
  const { result, rerender, unmount } = renderHook(({ values }) => useJustEntered(values), {
    initialProps: { values: [] as string[] },
  });
  expect([...result.current]).toEqual([]);
  rerender({ values: ["A"] });
  expect([...result.current]).toEqual(["A"]);
  act(() => vi.advanceTimersByTime(100));
  rerender({ values: next });
  act(() => vi.advanceTimersByTime(remaining - 1));
  expect([...result.current]).toEqual(expected);
  act(() => vi.advanceTimersByTime(1));
  expect([...result.current]).toEqual([]);
  rerender({ values: ["C"] });
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

describe("ScreenerToolbar primary bar and collapsible All filters drawer", () => {
  it("defaults the All filters drawer to collapsed on both desktop and mobile and reveals controls on click", () => {
    const { onChange, onSearchChange } = renderToolbar({ coins: ["usdc-circle"] }, { activeFilterCount: 2 });

    const toggle = screen.getByRole("button", { name: /All filters \(2 active\)/i });
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.classList.contains("hidden")).toBe(true);
    expect(
      screen.getByText("Showing an exact 1-coin selection. Reset filters to restore the full universe."),
    ).toBeTruthy();
    expect(screen.queryByText(/Picker shortlist/i)).toBeNull();

    // Primary search + 1-click preset pills work while the drawer stays collapsed.
    const searchInput = screen.getByLabelText(/Search stablecoins by name or ticker/i);
    expect(searchInput.getAttribute("placeholder")).toBe("Search coin...");
    fireEvent.change(searchInput, {
      target: { value: "usdc" },
    });
    expect(onSearchChange).toHaveBeenCalledWith("usdc");

    fireEvent.click(screen.getByRole("button", { name: "Unfreezable" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ blacklistable: ["no"] }));

    fireEvent.click(screen.getByRole("button", { name: /Include tokenized funds/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ includeFunds: true }));

    // Expanding the drawer exposes the full 18-control panel.
    fireEvent.click(toggle);
    expect(panel.classList.contains("hidden")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Depeg" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ states: ["depeg"] }));
    expect(screen.getByRole("button", { name: "DEWS Alert+" }).getAttribute("title")).toBe("DEWS Alert or worse");
  });

  it("wires primary quick selects for Grade, Mechanism, Peg, and Supply and uses crisp reader-facing labels", () => {
    const { onChange } = renderToolbar();

    fireEvent.change(screen.getByLabelText("Filter by safety grade tier"), { target: { value: "A" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ safetyGrades: ["A+", "A", "A-"] }));

    fireEvent.change(screen.getByLabelText("Filter by peg currency"), { target: { value: "EUR" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ pegs: ["EUR"] }));

    fireEvent.change(screen.getByLabelText("Filter by minimum supply"), { target: { value: "1000000000" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ supplyMin: 1_000_000_000 }));

    // Verify duplicate "V10 Mint Component" and "PegScore" are fixed, and V10 is stripped.
    expect(screen.queryByText(/V10/)).toBeNull();
    expect(screen.queryByText("PegScore")).toBeNull();
    expect(screen.getByText("Peg Score")).toBeTruthy();
    expect(screen.getByText("Mint Control")).toBeTruthy();
    expect(screen.getByText("Mint Control posture")).toBeTruthy();
    expect(screen.getByText("Safety evidence")).toBeTruthy();
    const nrButtons = screen.getAllByRole("button", { name: "NR" });
    expect(nrButtons.length).toBeGreaterThanOrEqual(1);
    expect(nrButtons.every((button) => button.className.includes("whitespace-nowrap"))).toBe(true);
  });
});

describe("ScreenerToolbar floor/ceiling guard", () => {
  it("clears a URL-carried DEWS ceiling when the visible DEWS floor passes it", () => {
    const { onChange } = renderToolbar({ dewsMax: 40 });

    setFloor("DEWS Stress", "60");

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dewsMin: 60, dewsMax: 100 }));
  });

  it("clears a URL-carried supply ceiling when the visible supply floor passes it", () => {
    const { onChange } = renderToolbar({ supplyMax: 1_000_000 });

    setFloor("Supply (USD)", "2000000");

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ supplyMin: 2_000_000, supplyMax: 0 }));
  });

  it("keeps a non-default ceiling the floor does not cross", () => {
    const { onChange } = renderToolbar({ dewsMax: 40, supplyMax: 5_000_000 });

    setFloor("DEWS Stress", "20");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ dewsMax: 40 }));

    setFloor("Supply (USD)", "1000000");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ supplyMax: 5_000_000 }));
  });
});
