// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackButton } from "@/components/feedback-button";
import { MobileUtilityDock } from "@/components/mobile-utility-dock";

const { pathnameMock } = vi.hoisted(() => ({ pathnameMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}));

vi.mock("@/components/feedback-modal-lazy", () => ({
  FeedbackModal: () => null,
}));

afterEach(() => {
  cleanup();
  window.scrollY = 0;
  vi.clearAllMocks();
});

describe("floating feedback entry routes", () => {
  it.each(["/api/", "/api", "/api/reference/", "/api/reference"])("offers no feedback control on %s and mounts scroll-to-top only while scrolling up past 400px", (pathname) => {
    pathnameMock.mockReturnValue(pathname);
    render(
      <>
        <FeedbackButton />
        <MobileUtilityDock />
      </>,
    );

    expect(screen.queryByRole("button", { name: /feedback/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    // Back-to-top mounts only while the reader scrolls back up past 400px,
    // avoiding an empty or half-empty pill on the way down.
    for (const [scrollY, visible] of [[23, false], [401, false], [900, false], [700, true], [650, true], [800, false], [600, true], [300, false]] as const) {
      fireEvent.scroll(window, { target: { scrollY } });
      const scroll = screen.queryByRole("button", { name: "Scroll to top" });
      expect(scroll !== null).toBe(visible);
    }
  });

  it("hides both desktop FeedbackButton and mobile dock feedback on a stablecoin dossier, which has its own report actions", () => {
    pathnameMock.mockReturnValue("/stablecoin/usdc-circle/");
    render(
      <>
        <FeedbackButton />
        <MobileUtilityDock />
      </>,
    );

    expect(screen.queryByRole("button", { name: /feedback/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    fireEvent.scroll(window, { target: { scrollY: 900 } });
    fireEvent.scroll(window, { target: { scrollY: 700 } });
    expect(screen.queryByRole("button", { name: /feedback/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();
  });

  it("keeps desktop FeedbackButton restricted to xl gutters on other product routes", () => {
    pathnameMock.mockReturnValue("/yield/");
    render(
      <>
        <FeedbackButton />
        <MobileUtilityDock />
      </>,
    );

    // At scrollY=0 only desktop FeedbackButton mounts; mobile dock stays unmounted.
    const [desktopButton] = screen.getAllByRole("button", { name: /feedback/i });
    expect(desktopButton.className).toContain("hidden");
    expect(desktopButton.className).toContain("xl:flex");
    expect(desktopButton.className).not.toContain("sm:flex");
    for (const scrollY of [23, 24, 25, 399, 400, 401, 24]) {
      fireEvent.scroll(window, { target: { scrollY } });
      expect(screen.getAllByRole("button", { name: /feedback/i })).toHaveLength(scrollY > 24 ? 2 : 1);
      // Scrolling down never leaves an invisible Scroll to top slot inside the pill.
      expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    }
    fireEvent.scroll(window, { target: { scrollY: 800 } });
    fireEvent.scroll(window, { target: { scrollY: 600 } });
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();
  });
});
