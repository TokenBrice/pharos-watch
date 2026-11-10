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
    for (const scrollY of [23, 24, 25, 399, 400, 401, 400, 24]) {
      fireEvent.scroll(window, { target: { scrollY } });
      expect(scroll.parentElement?.parentElement?.classList.contains("invisible")).toBe(scrollY <= 400);
      expect(scroll.tabIndex).toBe(scrollY > 400 ? 0 : -1);
    }
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
