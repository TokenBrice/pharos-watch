// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCompareSelection } from "../use-compare-selection";

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

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

  it("removes compare params when only legacy ids remain", async () => {
    window.history.replaceState(null, "", "/compare/?coins=1,2&range=30d");

    const { result } = renderHook(() => useCompareSelection());

    await waitFor(() => {
      expect(window.location.search).toBe("?range=30d");
    });

    expect(result.current.selectedIds).toEqual([]);
  });

  it("leaves canonical params unchanged", async () => {
    window.history.replaceState(null, "", "/compare/?coins=usdc-circle,usdt-tether&range=90d");

    const { result } = renderHook(() => useCompareSelection());

    await waitFor(() => {
      expect(result.current.selectedIds).toEqual(["usdc-circle", "usdt-tether"]);
    });

    expect(window.location.search).toBe("?coins=usdc-circle,usdt-tether&range=90d");
  });
});
