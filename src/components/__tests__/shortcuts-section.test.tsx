// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ShortcutsSection } from "@/components/shortcuts-section";
import { SHORTCUTS_STORAGE_KEY } from "@/hooks/use-shortcuts";

describe("ShortcutsSection", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("fills the desktop view to twelve shortcuts without mutating a smaller saved list", async () => {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(["/chains/", "/portfolio/"]));

    render(<ShortcutsSection />);

    await waitFor(() => {
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(12);
      expect(links[0].textContent).toContain("Chains");
      expect(links[1].textContent).toContain("Portfolio");
    });

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    expect(screen.getAllByRole("button", { name: /remove .* shortcut/i })).toHaveLength(2);
  });
});
