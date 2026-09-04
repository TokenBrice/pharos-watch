// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, useContext, type ReactNode } from "react";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";
import { makeHealthyHealthResponse } from "@/test-utils/status-fixtures";
import { TopNav } from "@/components/top-nav";

const { useHealthMock } = vi.hoisted(() => ({ useHealthMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("@/components/pharos-logo", () => ({
  PharosLogo: () => <span aria-hidden="true" data-testid="pharos-logo" />,
}));

vi.mock("@/lib/command-palette", () => ({
  openCommandPalette: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useHealth: useHealthMock,
}));

const DropdownOpenContext = createContext(false);

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children, open = false }: { children: ReactNode; open?: boolean }) => (
    <DropdownOpenContext.Provider value={open}>{children}</DropdownOpenContext.Provider>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({
    children,
    onMouseEnter,
    onMouseLeave,
  }: {
    children: ReactNode;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
  }) => {
    const open = useContext(DropdownOpenContext);
    return open ? (
      <div role="menu" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        {children}
      </div>
    ) : null;
  },
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div role="menuitem">{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

afterEach(() => {
  cleanupFrontendTest();
});

describe("TopNav", () => {
  beforeEach(() => {
    useHealthMock.mockReturnValue({
      data: makeHealthyHealthResponse(),
      isError: false,
    });
  });

  it("promotes the highest-traffic routes to direct links instead of menu items", async () => {
    installMatchMediaMock(true);

    render(<TopNav />);

    const rail = document.querySelector('nav[aria-label="Quick links"]');
    const railLinks = [...(rail?.querySelectorAll("a") ?? [])];

    // next/link normalizes the trailing slash away in the rendered anchor.
    expect(railLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/",
      "/safety-scores",
      "/yield",
      "/depeg",
      "/stability-index",
    ]);
    // Icons are the affordance that separates a direct link from a menu trigger.
    expect(railLinks.every((link) => link.querySelector("svg") !== null)).toBe(true);
    expect(railLinks[0].getAttribute("aria-current")).toBe("page");
  });

  it("expands descriptive rail labels before expanding the search control", () => {
    installMatchMediaMock(true);

    render(<TopNav />);

    const ddrLink = screen.getByRole("link", { name: /Depeg & Recovery/ });
    const compactLabel = ddrLink.querySelector("span.xl\\:hidden");
    const fullLabel = ddrLink.querySelector("span.hidden.xl\\:inline");
    const search = screen.getByRole("button", { name: "Search" });

    expect(compactLabel?.textContent).toBe("DDR");
    expect(fullLabel?.textContent).toBe("Depeg & Recovery");
    expect(search.className).toContain("2xl:w-72");
    expect(search.className).not.toContain("xl:w-44");
    expect(search.querySelector("span")?.className).toContain("2xl:inline");
  });

  it("opens the More panel on hover with the tail grouped into columns", async () => {
    const matchMedia = installMatchMediaMock(true);

    render(<TopNav />);

    await waitFor(() => {
      expect(matchMedia).toHaveBeenCalledWith("(hover: hover) and (pointer: fine)");
    });

    fireEvent.mouseEnter(screen.getByRole("button", { name: "More" }));

    const columnHeadings = [...document.querySelectorAll("p.pharos-kicker")].map((node) => node.textContent);
    expect(columnHeadings).toEqual(["Learn", "Updates", "Pharos"]);

    const changelog = screen.getByText("Changelog");
    const apiAccess = screen.getByText("API Access");
    const status = screen.getByText("Pharos is Healthy");

    expect(changelog.compareDocumentPosition(apiAccess) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(apiAccess.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Health must stay gated to the open panel: no /api/health poll per page view.
    expect(useHealthMock).toHaveBeenLastCalledWith({ enabled: true });
  });

  it("reports degraded public health instead of a static healthy claim", async () => {
    installMatchMediaMock(true);
    useHealthMock.mockReturnValue({
      data: { ...makeHealthyHealthResponse(), status: "degraded" },
      isError: false,
    });

    render(<TopNav />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "More" }));

    const status = await screen.findByText("Pharos is Degraded");
    const dot = status.closest("a")?.querySelector("span.rounded-full");
    expect(dot?.classList.contains("bg-[var(--severity-mild)]")).toBe(true);
  });

  it("uses a neutral label when public health cannot be loaded", async () => {
    installMatchMediaMock(true);
    useHealthMock.mockReturnValue({ data: undefined, isError: true });

    render(<TopNav />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "More" }));

    expect(await screen.findByText("Status Unavailable")).not.toBeNull();
  });
});
