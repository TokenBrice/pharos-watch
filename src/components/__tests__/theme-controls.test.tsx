// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import { ThemeControls } from "@/components/theme-controls";

const { setThemeMock } = vi.hoisted(() => ({ setThemeMock: vi.fn() }));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: setThemeMock }),
}));

afterEach(() => {
  cleanupFrontendTest();
  setThemeMock.mockClear();
});

describe("ThemeControls", () => {
  it("marks only the active system theme as pressed", () => {
    render(<ThemeControls density="desktop" />);
    expect(screen.getByRole("button", { name: "Dark theme" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Light theme" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "System theme" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("selects a theme at mobile density", () => {
    render(<ThemeControls density="mobile" />);

    fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(setThemeMock).toHaveBeenCalledWith("dark");
  });

  it("labels each option visibly and cross-fades the switch through a view transition", () => {
    const startViewTransition = vi.fn((callback: () => void) => callback());
    Object.defineProperty(document, "startViewTransition", { value: startViewTransition, configurable: true });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    try {
      render(<ThemeControls density="desktop" />);
      const dark = screen.getByRole("button", { name: "Dark theme" });
      expect(dark.textContent).toBe("Dark");
      fireEvent.click(dark);
      expect(startViewTransition).toHaveBeenCalledTimes(1);
      expect(setThemeMock).toHaveBeenCalledWith("dark");
    } finally {
      delete (document as { startViewTransition?: unknown }).startViewTransition;
      vi.unstubAllGlobals();
    }
  });
});
