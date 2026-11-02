// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenerToolbar } from "@/components/screener/screener-toolbar";
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
