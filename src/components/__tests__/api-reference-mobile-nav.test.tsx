// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiReferenceMobileNav } from "@/components/api-reference-mobile-nav";
import type { SidebarSection } from "@/components/api-reference-sidebar";


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

  it("shows the current section label", () => {
    render(
      <ApiReferenceMobileNav
        sections={MOCK_SECTIONS}
        activeId="surface-split"
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("Surface Split")).toBeTruthy();
  });

  it("shows the endpoint label when a subsection is active", () => {
    render(
      <ApiReferenceMobileNav
        sections={MOCK_SECTIONS}
        activeId="get-api-stablecoins"
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("/api/stablecoins")).toBeTruthy();
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
