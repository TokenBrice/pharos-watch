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
  it.each(["/api/", "/api", "/api/reference/", "/api/reference"])("offers no feedback control on %s but keeps the dock's scroll control", (pathname) => {
    pathnameMock.mockReturnValue(pathname);
    render(
      <>
        <FeedbackButton />
        <MobileUtilityDock />
      </>,
    );

    expect(screen.queryByRole("button", { name: /feedback/i, hidden: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Scroll to top", hidden: true })).toBeTruthy();
    const scroll = screen.getByRole("button", { name: "Scroll to top", hidden: true });
    // Back-to-top appears only while the reader scrolls back up past 400px,
    // so it never parks over content on the way down.
    for (const [scrollY, visible] of [[23, false], [401, false], [900, false], [700, true], [650, true], [800, false], [600, true], [300, false]] as const) {
      fireEvent.scroll(window, { target: { scrollY } });
      expect(scroll.parentElement?.parentElement?.classList.contains("invisible")).toBe(!visible);
      expect(scroll.tabIndex).toBe(visible ? 0 : -1);
    }
  });

  it("keeps the phone dock's feedback pill off a stablecoin dossier, which has its own report action", () => {
    pathnameMock.mockReturnValue("/stablecoin/usdc-circle/");
    render(<MobileUtilityDock />);

    expect(screen.queryByRole("button", { name: /feedback/i, hidden: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Scroll to top", hidden: true })).toBeTruthy();
  });

  it("keeps both feedback controls on other product routes", () => {
    pathnameMock.mockReturnValue("/yield/");
    render(
      <>
        <FeedbackButton />
        <MobileUtilityDock />
      </>,
    );

    expect(screen.getAllByRole("button", { name: /feedback/i, hidden: true })).toHaveLength(2);
    const feedback = screen.getAllByRole("button", { name: /feedback/i, hidden: true })[1];
    for (const scrollY of [23, 24, 25, 399, 400, 401, 24]) {
      fireEvent.scroll(window, { target: { scrollY } });
      expect(feedback.parentElement?.parentElement?.classList.contains("invisible")).toBe(scrollY <= 24);
      expect(feedback.tabIndex).toBe(scrollY > 24 ? 0 : -1);
    }
  });
});
