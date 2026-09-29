// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
  vi.clearAllMocks();
});

describe("floating feedback entry routes", () => {
  it.each(["/api/", "/api"])("offers no feedback control on %s but keeps the dock's scroll control", (pathname) => {
    pathnameMock.mockReturnValue(pathname);
    render(
      <>
        <FeedbackButton />
        <MobileUtilityDock />
      </>,
    );

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
  });
});
