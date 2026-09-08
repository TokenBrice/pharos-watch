// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

import ChangelogPage from "@/app/changelog/page";
import { changelogs } from "@/data/changelogs";

vi.mock("next/link", async () => {
  // vi.mock factories are hoisted above static imports, so the mock helper
  // can only be loaded through a dynamic import here.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

// jsdom lacks IntersectionObserver; ChangelogWeekNav only tracks visibility with it.
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChangelogPage", () => {
  it("renders the page masthead", () => {
    render(<ChangelogPage />);
    expect(screen.getByRole("heading", { level: 1, name: /Changelog/i })).toBeTruthy();
  });
  it("anchors every changelog entry to its week and marks the latest one", () => {
    render(<ChangelogPage />);

    expect(changelogs.length).toBeGreaterThan(0);
    for (const entry of changelogs) {
      const weekSection = document.getElementById(`week-${entry.dateRange.to}`);
      expect(weekSection).not.toBeNull();
      const headingLink = weekSection!.querySelector(`a[href="#${entry.dateRange.to}"]`);
      expect(headingLink).not.toBeNull();
      expect(headingLink?.querySelector("time")?.getAttribute("datetime")).toBe(entry.dateRange.to);
    }

    const latestEntry = changelogs[0];
    expect(latestEntry).toBeDefined();
    expect(document.getElementById(`week-${latestEntry!.dateRange.to}`)?.textContent).toContain("Latest");
  });
});
