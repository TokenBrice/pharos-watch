// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useRegisteredApiQueryMock, isBlacklistBannerEnabledMock } = vi.hoisted(() => ({
  useRegisteredApiQueryMock: vi.fn(),
  isBlacklistBannerEnabledMock: vi.fn(),
}));

vi.mock("../api-hooks", () => ({
  useRegisteredApiQuery: useRegisteredApiQueryMock,
}));

vi.mock("@/lib/feature-flags", () => ({
  isBlacklistBannerEnabled: isBlacklistBannerEnabledMock,
}));

import { useRecentBlacklist7d } from "../use-recent-blacklist-7d";

describe("useRecentBlacklist7d", () => {
  beforeEach(() => {
    useRegisteredApiQueryMock.mockReset();
    isBlacklistBannerEnabledMock.mockReset();
  });

  it("returns null when the banner flag is disabled", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(false);
    useRegisteredApiQueryMock.mockReturnValue({ data: undefined, meta: null });

    const { result } = renderHook(() => useRecentBlacklist7d("USDC"));

    expect(result.current).toBeNull();
  });

  it("returns null when the symbol is not in BLACKLIST_STABLECOINS", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(true);
    useRegisteredApiQueryMock.mockReturnValue({ data: undefined, meta: null });

    const { result } = renderHook(() => useRecentBlacklist7d("DAI"));

    expect(result.current).toBeNull();
  });

  it("returns the per-coin aggregate when both gates pass and summary contains the symbol", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(true);
    useRegisteredApiQueryMock.mockReturnValue({
      data: {
        stats: {
          perCoinRecentEventTypes: {
            USDC: { freezes: 7, destroys: 1, releases: 2 },
          },
        },
      },
      meta: { status: "fresh" },
    });

    const { result } = renderHook(() => useRecentBlacklist7d("USDC"));

    expect(result.current).toEqual({ freezes: 7, destroys: 1, releases: 2 });
  });

  it("returns zero-counts when summary is empty for the coin", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(true);
    useRegisteredApiQueryMock.mockReturnValue({
      data: { stats: { perCoinRecentEventTypes: {} } },
      meta: { status: "fresh" },
    });

    const { result } = renderHook(() => useRecentBlacklist7d("USDC"));

    expect(result.current).toEqual({ freezes: 0, destroys: 0, releases: 0 });
  });
});
