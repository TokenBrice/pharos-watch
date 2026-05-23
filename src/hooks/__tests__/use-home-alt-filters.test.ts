// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useHomeAltFilters } from "@/hooks/use-home-alt-filters";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
});

describe("useHomeAltFilters", () => {
  it("updates after same-page URL navigation", async () => {
    const { result } = renderHook(() => useHomeAltFilters());

    expect(result.current.activePeg).toBe("all");

    await act(async () => {
      window.history.pushState(null, "", "/?peg=fiat-non-usd-peg#home-alt-rankings");
      await Promise.resolve();
    });

    expect(result.current.activePeg).toBe("fiat-non-usd-peg");
    expect(result.current.activeFilters).toEqual(["fiat-non-usd-peg"]);
  });

  it("maps legacy commodity peg URLs to the grouped commodity filter", () => {
    window.history.replaceState(null, "", "/?peg=gold-peg#home-alt-rankings");

    const { result } = renderHook(() => useHomeAltFilters());

    expect(result.current.activePeg).toBe("commodity-peg");
    expect(result.current.activeFilters).toEqual(["commodity-peg"]);
  });

  it("maps legacy non-USD fiat peg URLs to the grouped fiat filter", () => {
    window.history.replaceState(null, "", "/?peg=eur-peg#home-alt-rankings");

    const { result } = renderHook(() => useHomeAltFilters());

    expect(result.current.activePeg).toBe("fiat-non-usd-peg");
    expect(result.current.activeFilters).toEqual(["fiat-non-usd-peg"]);
  });
});
