// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenerToolbar } from "@/components/screener/screener-toolbar";
import { useJustEntered } from "@/hooks/use-just-entered";
import { SCREENER_FILTER_DEFAULTS, type ScreenerFilters } from "@/lib/screener-filters";
import { cleanupFrontendTest } from "@/test-utils/frontend";

function renderToolbar(filters: Partial<ScreenerFilters> = {}) {
  const onChange = vi.fn();
  render(
    <ScreenerToolbar
      filters={{ ...SCREENER_FILTER_DEFAULTS, ...filters }}
      matchingRows={1}
      totalRows={1}
      dataState="ready"
      activeFilterCount={0}
      onChange={onChange}
      onReset={vi.fn()}
    />,
  );
  return onChange;
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

describe("ScreenerToolbar floor/ceiling guard", () => {
  it("clears a URL-carried DEWS ceiling when the visible DEWS floor passes it", () => {
    const onChange = renderToolbar({ dewsMax: 40 });

    setFloor("DEWS Stress", "60");

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dewsMin: 60, dewsMax: 100 }));
  });

  it("clears a URL-carried supply ceiling when the visible supply floor passes it", () => {
    const onChange = renderToolbar({ supplyMax: 1_000_000 });

    setFloor("Supply (USD)", "2000000");

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ supplyMin: 2_000_000, supplyMax: 0 }));
  });

  it("keeps a non-default ceiling the floor does not cross", () => {
    const onChange = renderToolbar({ dewsMax: 40, supplyMax: 5_000_000 });

    setFloor("DEWS Stress", "20");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ dewsMax: 40 }));

    setFloor("Supply (USD)", "1000000");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ supplyMax: 5_000_000 }));
  });
});
