// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiReferenceMobileNav } from "@/components/api-reference/api-reference-mobile-nav";
import { ApiReferenceLayout } from "@/components/api-reference/api-reference-layout";
import type { SidebarSection } from "@/components/api-reference/api-reference-sidebar";


const MOCK_SECTIONS: SidebarSection[] = [
  { id: "surface-split", label: "Surface Split", subsections: [] },
  {
    id: "public-endpoints",
    label: "Public Endpoints",
    subsections: [
      { id: "get-api-stablecoins", label: "/api/stablecoins", method: "GET" },
    ],
  },
];

describe("ApiReferenceMobileNav", () => {
  it.each([
    ["#%", "surface-split"],
    ["#%E0%A4%A", "surface-split"],
    ["#get-api-%73tablecoins", "get-api-stablecoins"],
  ])("keeps layout navigation usable with initial fragment %s", async (fragment, initialId) => {
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", fragment);
    try {
      render(<ApiReferenceLayout sections={MOCK_SECTIONS}>
        <section id="surface-split" /><section id="get-api-stablecoins" />
      </ApiReferenceLayout>);
      const desktop = screen.getByRole("navigation", { name: "API reference navigation" });
      await waitFor(() => expect(desktop.querySelector('[aria-current="true"]')?.getAttribute("data-sidebar-id")).toBe(initialId));
      expect(window.location.hash).toBe(fragment);
      fireEvent.click(within(desktop).getByRole("button", { name: "Surface Split" }));
      fireEvent.click(screen.getByRole("button", { name: "Open API navigation" }));
      const panel = screen.getByRole("dialog");
      fireEvent.click(within(panel).getByRole("button", { name: "Public Endpoints" }));
      fireEvent.click(within(panel).getByRole("button", { name: /GET.*\/api\/stablecoins/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(window.location.hash).toBe("#get-api-stablecoins");
      expect(within(desktop).getByRole("button", { name: /GET.*\/api\/stablecoins/i }).getAttribute("aria-current")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Open API navigation" }));
      expect(within(screen.getByRole("dialog")).getByRole("button", { name: /GET.*\/api\/stablecoins/i }).getAttribute("aria-current")).toBe("true");
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      window.history.replaceState(null, "", window.location.pathname);
    }
  });

  it("opens endpoint navigation and closes after selecting an endpoint", async () => {
    const onNavigate = vi.fn();
    render(<ApiReferenceMobileNav sections={MOCK_SECTIONS} activeId="" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Open API navigation" }));
    const panel = screen.getByRole("dialog");
    fireEvent.click(within(panel).getByRole("button", { name: "Public Endpoints" }));
    fireEvent.click(within(panel).getByRole("button", { name: /GET.*\/api\/stablecoins/i }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("get-api-stablecoins");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("dismisses with Escape and restores trigger focus", async () => {
    render(<ApiReferenceMobileNav sections={MOCK_SECTIONS} activeId="" onNavigate={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Open API navigation" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
