// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MiniAppScreenshotCarousel } from "./mini-app-screenshot-carousel";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";

vi.mock("next/image", () => ({
  default: ({ alt, ...props }: { alt: string; src: string; width: number; height: number; className?: string }) => (
    <img alt={alt} {...props} />
  ),
}));

const SCREENSHOTS = [
  { title: "Home", src: "/home.png", alt: "Home screen", width: 320, height: 640 },
  { title: "Watchlist", src: "/watchlist.png", alt: "Watchlist screen", width: 320, height: 640 },
  { title: "Presets", src: "/presets.png", alt: "Presets screen", width: 320, height: 640 },
  { title: "Settings", src: "/settings.png", alt: "Settings screen", width: 320, height: 640 },
] as const;

afterEach(() => {
  cleanupFrontendTest();
});

describe("MiniAppScreenshotCarousel", () => {
  it("keeps narrow-screen controls wrap-safe and at least 44px", () => {
    installMatchMediaMock();
    render(<MiniAppScreenshotCarousel screenshots={SCREENSHOTS} />);

    const pause = screen.getByRole("button", { name: "Pause Mini App screenshots" });
    expect(pause.className).toContain("size-11");
    expect(pause.className).toContain("shrink-0");
    expect(pause.parentElement?.className).toContain("flex-wrap");

    for (const screenshot of SCREENSHOTS) {
      const control = screen.getByRole("button", { name: `Show ${screenshot.title} screenshot` });
      expect(control.className).toContain("min-h-11");
      expect(control.className).toContain("shrink-0");
    }

    fireEvent.click(screen.getByRole("button", { name: "Show Watchlist screenshot" }));
    expect(screen.getByRole("button", { name: "Show Watchlist screenshot" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Play Mini App screenshots" })).toBeTruthy();
  });
});
