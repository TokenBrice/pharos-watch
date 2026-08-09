// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useRecentBlacklist7dMock, isBlacklistBannerEnabledMock } = vi.hoisted(() => ({
  useRecentBlacklist7dMock: vi.fn(),
  isBlacklistBannerEnabledMock: vi.fn(),
}));

vi.mock("@/hooks/use-recent-blacklist-7d", () => ({
  useRecentBlacklist7d: useRecentBlacklist7dMock,
}));

vi.mock("@/lib/feature-flags", () => ({
  isBlacklistBannerEnabled: isBlacklistBannerEnabledMock,
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import { RecentBlacklistBanner } from "../recent-blacklist-banner";

describe("RecentBlacklistBanner", () => {
  beforeEach(() => {
    useRecentBlacklist7dMock.mockReset();
    isBlacklistBannerEnabledMock.mockReset();
  });

  afterEach(cleanup);

  it("returns null when the feature flag is off", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(false);
    useRecentBlacklist7dMock.mockReturnValue({ freezes: 10, destroys: 3, releases: 0 });
    const { container } = render(<RecentBlacklistBanner symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when coinStatus === 'frozen'", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(true);
    useRecentBlacklist7dMock.mockReturnValue({ freezes: 10, destroys: 3, releases: 0 });
    const { container } = render(
      <RecentBlacklistBanner symbol="USDC" coinStatus="frozen" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when destroys === 0 && freezes < 5", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(true);
    useRecentBlacklist7dMock.mockReturnValue({ freezes: 4, destroys: 0, releases: 0 });
    const { container } = render(<RecentBlacklistBanner symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders when destroys > 0 (even if freezes < 5)", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(true);
    useRecentBlacklist7dMock.mockReturnValue({ freezes: 1, destroys: 1, releases: 0 });
    render(<RecentBlacklistBanner symbol="USDC" />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("1");
    expect(banner.textContent).toContain("freeze");
    expect(banner.textContent).toContain("destroy");
    expect(banner.getAttribute("aria-label")).toContain("in the last 7 days");
  });

  it("renders when freezes >= 5", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(true);
    useRecentBlacklist7dMock.mockReturnValue({ freezes: 7, destroys: 0, releases: 0 });
    render(<RecentBlacklistBanner symbol="USDC" />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("7");
    expect(banner.textContent).toContain("freezes");
    // No destroy clause when destroys === 0
    expect(banner.textContent).not.toContain("destroy");
  });

  it("renders the Snowflake icon plus freeze, destroy, and release counts", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(true);
    useRecentBlacklist7dMock.mockReturnValue({ freezes: 12, destroys: 2, releases: 1 });
    const { container } = render(<RecentBlacklistBanner symbol="USDC" />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("12");
    expect(banner.textContent).toContain("freezes");
    expect(banner.textContent).toContain("2");
    expect(banner.textContent).toContain("destroys");
    expect(banner.textContent).toContain("1");
    expect(banner.textContent).toContain("release");
    // The Snowflake lucide icon renders as an inline <svg>.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("returns null when the hook returns null (gated path)", () => {
    isBlacklistBannerEnabledMock.mockReturnValue(true);
    useRecentBlacklist7dMock.mockReturnValue(null);
    const { container } = render(<RecentBlacklistBanner symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });
});
