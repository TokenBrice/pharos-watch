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
  it("renders the desktop density with the existing compact menu classes", () => {
    const { container } = render(<ThemeControls density="desktop" />);

    expect(container.firstElementChild?.className).toBe("flex items-center gap-1 px-1.5 py-1");
    expect(screen.getByRole("button", { name: "System theme" }).className).toBe(
      "inline-flex size-8 items-center justify-center rounded-md transition-colors bg-muted text-foreground",
    );
    expect(screen.getByRole("button", { name: "Dark theme" }).className).toBe(
      "inline-flex size-8 items-center justify-center rounded-md transition-colors text-muted-foreground hover:bg-muted/40 hover:text-foreground",
    );
    expect(screen.getByRole("button", { name: "System theme" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders the mobile touch density and selects a theme", () => {
    const { container } = render(<ThemeControls density="mobile" />);

    expect(container.firstElementChild?.className).toBe("flex items-center gap-1");
    expect(screen.getByRole("button", { name: "System theme" }).className).toBe(
      "pharos-focus-ring inline-flex size-11 items-center justify-center rounded-md transition-colors bg-muted text-foreground",
    );
    expect(screen.getByRole("button", { name: "Dark theme" }).className).toBe(
      "pharos-focus-ring inline-flex size-11 items-center justify-center rounded-md transition-colors text-muted-foreground hover:bg-muted/40 hover:text-foreground",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(setThemeMock).toHaveBeenCalledWith("dark");
  });
});
