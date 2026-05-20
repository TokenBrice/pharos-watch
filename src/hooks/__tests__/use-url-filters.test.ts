// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUrlFilterClearValue, useUrlFilters } from "@/hooks/use-url-filters";

function UrlFilterProbe() {
  const { searchParams } = useUrlFilters();
  return createElement("div", { "data-testid": "peg-filter" }, searchParams.get("peg") ?? "");
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
});

describe("isUrlFilterClearValue", () => {
  it("clears only explicit global sentinel values", () => {
    expect(isUrlFilterClearValue("")).toBe(true);
    expect(isUrlFilterClearValue("all")).toBe(true);
  });

  it("preserves numeric and non-sentinel string values", () => {
    expect(isUrlFilterClearValue("1")).toBe(false);
    expect(isUrlFilterClearValue("0")).toBe(false);
    expect(isUrlFilterClearValue("USD")).toBe(false);
  });
});

describe("useUrlFilters", () => {
  it("syncs search params after same-page history navigation", async () => {
    render(createElement(UrlFilterProbe));

    expect(screen.getByTestId("peg-filter").textContent).toBe("");

    await act(async () => {
      window.history.pushState(null, "", "/?peg=fiat-non-usd-peg#filter-bar");
      await Promise.resolve();
    });

    expect(screen.getByTestId("peg-filter").textContent).toBe("fiat-non-usd-peg");
  });
});
