// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useHomepageFilters } from "@/hooks/use-homepage-filters";

function HomepageFiltersProbe() {
  const filters = useHomepageFilters();
  return createElement("div", { "data-testid": "homepage-peg-filter" }, filters.groupSelections.Peg ?? "");
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
});

describe("useHomepageFilters", () => {
  it("updates the peg selection after same-page URL navigation", () => {
    render(createElement(HomepageFiltersProbe));

    expect(screen.getByTestId("homepage-peg-filter").textContent).toBe("");

    act(() => {
      window.history.pushState(null, "", "/?peg=fiat-non-usd-peg#filter-bar");
    });

    expect(screen.getByTestId("homepage-peg-filter").textContent).toBe("fiat-non-usd-peg");
  });
});
