// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_YIELD_COMPARE_IDS, useYieldCompareSelection } from "../use-yield-compare-selection";

describe("useYieldCompareSelection", () => {
  const gtag = vi.fn();

  beforeEach(() => {
    window.gtag = gtag;
    vi.spyOn(window, "queueMicrotask").mockImplementation((callback) => {
      callback();
    });
    window.history.replaceState(null, "", "/yield/");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    gtag.mockReset();
    delete window.gtag;
  });

  it("hydrates ids from the ?compare= URL param", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether");
    const { result } = renderHook(() => useYieldCompareSelection());

    expect(result.current.ids).toEqual(["usdc-circle", "usdt-tether"]);
    expect(result.current.has("usdc-circle")).toBe(true);
    expect(result.current.has("usds-sky")).toBe(false);
  });

  it("toggles ids in and out of the URL", () => {
    const { result } = renderHook(() => useYieldCompareSelection());

    act(() => result.current.toggle("usdc-circle"));
    expect(window.location.search).toBe("?compare=usdc-circle");
    expect(result.current.ids).toEqual(["usdc-circle"]);

    act(() => result.current.toggle("usdt-tether"));
    expect(result.current.ids).toEqual(["usdc-circle", "usdt-tether"]);

    act(() => result.current.toggle("usdc-circle"));
    expect(result.current.ids).toEqual(["usdt-tether"]);
    expect(window.location.search).toBe("?compare=usdt-tether");
    expect(gtag).toHaveBeenCalledWith("event", "yield_compare_changed", {
      action: "added",
      coin_count: 1,
      coin_id: "usdc-circle",
    });
    expect(gtag).toHaveBeenCalledWith("event", "yield_compare_changed", {
      action: "removed",
      coin_count: 1,
      coin_id: "usdc-circle",
    });
  });

  it("clears the param when no ids remain", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle");
    const { result } = renderHook(() => useYieldCompareSelection());

    act(() => result.current.toggle("usdc-circle"));
    expect(window.location.search).toBe("");
  });

  it("caps the selection at MAX_YIELD_COMPARE_IDS and no-ops on new ids past the cap", () => {
    const initial = Array.from({ length: MAX_YIELD_COMPARE_IDS }, (_, i) => `coin-${i}`);
    window.history.replaceState(null, "", `/yield/?compare=${initial.join(",")}`);
    const { result } = renderHook(() => useYieldCompareSelection());

    expect(result.current.ids).toHaveLength(MAX_YIELD_COMPARE_IDS);
    expect(result.current.canAdd).toBe(false);

    act(() => result.current.toggle("coin-extra"));
    expect(result.current.ids).toEqual(initial);
    expect(result.current.has("coin-extra")).toBe(false);

    // Existing ids can still be removed even at the cap.
    act(() => result.current.toggle("coin-0"));
    expect(result.current.ids).toEqual(initial.slice(1));
    expect(result.current.canAdd).toBe(true);
  });

  it("ignores duplicate ids when parsing the URL", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdc-circle,usdt-tether");
    const { result } = renderHook(() => useYieldCompareSelection());

    expect(result.current.ids).toEqual(["usdc-circle", "usdt-tether"]);
  });

  it("clear() removes the compare param entirely", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether&keep=1");
    const { result } = renderHook(() => useYieldCompareSelection());

    act(() => result.current.clear());
    expect(result.current.ids).toEqual([]);
    expect(window.location.search).toBe("?keep=1");
    expect(gtag).toHaveBeenCalledWith("event", "yield_compare_changed", {
      action: "cleared",
      coin_count: 0,
      coin_id: "",
    });
  });
});
