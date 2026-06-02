// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useHomepageDiscoverySuggestions } from "@/hooks/use-homepage-discovery";
import {
  HOMEPAGE_DISCOVERY_ROTATION_POOL,
  HOMEPAGE_DISCOVERY_STORAGE_KEY,
  selectHomepageDiscoverySuggestions,
} from "@/lib/homepage-discovery";

describe("useHomepageDiscoverySuggestions", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("uses the persisted visit cursor and advances it for the next homepage visit", async () => {
    window.localStorage.setItem(HOMEPAGE_DISCOVERY_STORAGE_KEY, JSON.stringify({ cursor: 1 }));
    const expectedHrefs = selectHomepageDiscoverySuggestions(
      HOMEPAGE_DISCOVERY_ROTATION_POOL,
      1,
    ).map((suggestion) => suggestion.href);

    const { result } = renderHook(() => useHomepageDiscoverySuggestions());

    await waitFor(() => {
      expect(result.current.map((suggestion) => suggestion.href)).toEqual(expectedHrefs);
    });
    expect(JSON.parse(window.localStorage.getItem(HOMEPAGE_DISCOVERY_STORAGE_KEY) ?? "null")).toEqual({
      cursor: 2,
    });
  });
});
