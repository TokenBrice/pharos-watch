// @vitest-environment jsdom

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement, useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCompareSelection } from "@/hooks/use-compare-selection";
import { useHomeAltFilters } from "@/hooks/use-home-alt-filters";
import { isUrlFilterClearValue, useUrlFilters } from "@/hooks/use-url-filters";

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

function UrlFilterProbe() {
  const { searchParams } = useUrlFilters();
  return createElement("div", { "data-testid": "peg-filter" }, searchParams.get("peg") ?? "");
}

function LateCommittedUrlProbe({ nextUrl }: { nextUrl: string }) {
  const { searchParams } = useUrlFilters();
  useLayoutEffect(() => {
    window.history.replaceState(null, "", nextUrl);
  }, [nextUrl]);
  return createElement("div", { "data-testid": "peg-filter" }, searchParams.get("peg") ?? "");
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});


describe("isUrlFilterClearValue", () => {
  it.each([
    { name: "clears only explicit global sentinel values", values: ["", "all"], expected: true },
    { name: "preserves numeric and non-sentinel string values", values: ["1", "0", "USD"], expected: false },
  ])("$name", ({ values, expected }) => {
    for (const value of values) {
      expect(isUrlFilterClearValue(value)).toBe(expected);
    }
  });
});

describe("useUrlFilters", () => {
  it("syncs search params after same-page history navigation", async () => {
    render(createElement(UrlFilterProbe));

    expect(screen.getByTestId("peg-filter").textContent).toBe("");

    await act(async () => {
      window.history.pushState(null, "", "/?peg=fiat-non-usd-peg#home-alt-rankings");
      await Promise.resolve();
    });

    expect(screen.getByTestId("peg-filter").textContent).toBe("fiat-non-usd-peg");
  });

  it("syncs the current browser URL after a route commits during mount", async () => {
    render(createElement(LateCommittedUrlProbe, { nextUrl: "/screener/?peg=USD" }));

    await waitFor(() => {
      expect(screen.getByTestId("peg-filter").textContent).toBe("USD");
    });
  });
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

  it("defaults to the core universe and exposes variants through the URL", async () => {
    const { result } = renderHook(() => useHomeAltFilters());

    expect(result.current.activeUniverse).toBe("core");

    await act(async () => {
      result.current.setActiveUniverse("variants");
      await Promise.resolve();
    });

    expect(result.current.activeUniverse).toBe("variants");
    expect(window.location.search).toBe("?variant=variants");

    await act(async () => {
      result.current.setActiveUniverse("core");
      await Promise.resolve();
    });

    expect(window.location.search).toBe("");
  });
});

describe("useCompareSelection", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/compare/");
  });

  it("rewrites mixed legacy and canonical compare params to canonical ids", async () => {
    window.history.replaceState(null, "", "/compare/?coins=1,usdc-circle&range=30d");

    const { result } = renderHook(() => useCompareSelection());

    await waitFor(() => {
      expect(window.location.search).toBe("?coins=usdc-circle&range=30d");
    });

    expect(result.current.selectedIds).toEqual(["usdc-circle"]);
  });

  it("leaves canonical params unchanged", async () => {
    window.history.replaceState(null, "", "/compare/?coins=usdc-circle,usdt-tether&range=90d");

    const { result } = renderHook(() => useCompareSelection());

    await waitFor(() => {
      expect(result.current.selectedIds).toEqual(["usdc-circle", "usdt-tether"]);
    });

    expect(window.location.search).toBe("?coins=usdc-circle,usdt-tether&range=90d");
  });

  it("adopts a static-link #coins= prefill into the query and drops the fragment", async () => {
    window.history.replaceState(null, "", "/compare/#coins=usdc-circle,1");

    const { result } = renderHook(() => useCompareSelection());

    await waitFor(() => {
      expect(window.location.search).toBe("?coins=usdc-circle");
    });
    expect(window.location.hash).toBe("");
    expect(result.current.selectedIds).toEqual(["usdc-circle"]);
  });

  it("keeps an explicit query selection over a prefill fragment", async () => {
    window.history.replaceState(null, "", "/compare/?coins=usdt-tether#coins=usdc-circle");

    const { result } = renderHook(() => useCompareSelection());

    await waitFor(() => {
      expect(window.location.hash).toBe("");
    });
    expect(window.location.search).toBe("?coins=usdt-tether");
    expect(result.current.selectedIds).toEqual(["usdt-tether"]);
  });
});
