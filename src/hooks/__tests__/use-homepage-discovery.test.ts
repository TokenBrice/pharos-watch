// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHomepageDiscoverySuggestions } from "@/hooks/use-homepage-discovery";
import {
  HOMEPAGE_DISCOVERY_ROTATION_POOL,
  HOMEPAGE_DISCOVERY_STORAGE_KEY,
  getHomepageDiscoveryCycleLength,
  selectHomepageDiscoverySuggestions,
} from "@/lib/homepage-discovery";

describe("useHomepageDiscoverySuggestions", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("randomizes the visit cursor and stores it for the next homepage visit", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.42);
    window.localStorage.setItem(HOMEPAGE_DISCOVERY_STORAGE_KEY, JSON.stringify({ cursor: 1 }));
    const expectedCursor = Math.floor(0.42 * getHomepageDiscoveryCycleLength());
    const expectedHrefs = selectHomepageDiscoverySuggestions(
      HOMEPAGE_DISCOVERY_ROTATION_POOL,
      expectedCursor,
    ).map((suggestion) => suggestion.href);

    const { result } = renderHook(() => useHomepageDiscoverySuggestions());

    await waitFor(() => {
      expect(result.current.map((suggestion) => suggestion.href)).toEqual(expectedHrefs);
    });
    expect(JSON.parse(window.localStorage.getItem(HOMEPAGE_DISCOVERY_STORAGE_KEY) ?? "null")).toEqual({
      cursor: expectedCursor,
    });
  });
});
