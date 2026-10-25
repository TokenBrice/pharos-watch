// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, useContext, type ReactNode } from "react";
import { TopNav } from "@/components/top-nav";
import { NAV_GROUPS } from "@/lib/nav-config";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";
import { makeHealthyHealthResponse } from "@/test-utils/status-fixtures";

const { useHealthMock, pathnameMock } = vi.hoisted(() => ({
  useHealthMock: vi.fn(),
  pathnameMock: { current: "/" as string },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.current,
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

vi.mock("@/components/regime-bar", () => ({
  RegimeBarToggle: () => null,
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
  DropdownMenuContent: ({ children }: { children: ReactNode }) => {
    const open = useContext(DropdownOpenContext);
    return open ? <div role="menu">{children}</div> : null;
  },
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div role="menuitem">{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

afterEach(() => {
  cleanupFrontendTest();
});

describe("TopNav", () => {
  beforeEach(() => {
    pathnameMock.current = "/";
    useHealthMock.mockReset();
    useHealthMock.mockReturnValue({
      data: makeHealthyHealthResponse(),
      isError: false,
    });
  });


  it("mounts every closed panel hidden and inert so its links are crawlable but not focusable", () => {
    installMatchMediaMock(true);

    render(<TopNav />);

    for (const menu of NAV_GROUPS) {
      const trigger = screen.getByRole("button", { name: menu.label });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      const panel = document.getElementById(trigger.getAttribute("aria-controls")!);
      expect(panel).not.toBeNull();
      expect(panel!.hidden).toBe(true);
      expect(panel!.hasAttribute("inert")).toBe(true);
      const hrefs = [...panel!.querySelectorAll<HTMLAnchorElement>("a[href]")].map((link) => link.getAttribute("href"));
      // next/link drops the trailing slash outside the app's trailingSlash config.
      const stripSlash = (href: string | null) => href?.replace(/(.)\/$/, "$1");
      expect(hrefs.map(stripSlash)).toEqual(menu.items.map((item) => stripSlash(item.href)));
    }
    // Closed panels are outside the accessibility tree and carry no health copy.
    const firstItem = NAV_GROUPS[0].items[0];
    expect(screen.queryByRole("link", { name: firstItem.label })).toBeNull();
    expect(screen.queryByText("Operational", { selector: "span" })).toBeNull();
    expect(useHealthMock).toHaveBeenLastCalledWith({ enabled: false });

    const trigger = screen.getByRole("button", { name: NAV_GROUPS[0].label });
    fireEvent.click(trigger);
    const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(false);
    expect(panel.hasAttribute("inert")).toBe(false);
  });

  it("opens Resources only after hover intent and renders its configured columns", () => {
    vi.useFakeTimers();
    const matchMedia = installMatchMediaMock(true);

    render(<TopNav />);
    expect(matchMedia).toHaveBeenCalledWith("(hover: hover) and (pointer: fine)");
    const trigger = screen.getByRole("button", { name: "Resources" });

    fireEvent.mouseEnter(trigger);

    act(() => vi.advanceTimersByTime(349));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    act(() => vi.advanceTimersByTime(1));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const resources = NAV_GROUPS.find((menu) => menu.key === "more");
    const columnHeadings = [...document.querySelectorAll("p.pharos-label")].map((node) => node.textContent);
    expect(columnHeadings).toEqual(resources?.columns?.map((column) => column.label));
    expect(useHealthMock).toHaveBeenLastCalledWith({ enabled: true });

    const hoverBridge = document.querySelector('[data-section-menu="more"] > div.absolute');
    expect(hoverBridge?.className).toContain("pt-2");
  });

  it("opens after 350ms from closed, switches after 100ms, and closes after 250ms", () => {
    vi.useFakeTimers();
    installMatchMediaMock(true);

    render(<TopNav />);

    const [firstMenu, secondMenu] = NAV_GROUPS;
    const firstTrigger = screen.getByRole("button", { name: firstMenu.label });
    const secondTrigger = screen.getByRole("button", { name: secondMenu.label });

    fireEvent.mouseEnter(firstTrigger);
    act(() => vi.advanceTimersByTime(350));
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseLeave(firstTrigger.closest("[data-section-menu]")!);
    fireEvent.mouseEnter(secondTrigger);
    act(() => vi.advanceTimersByTime(99));
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(secondTrigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseLeave(secondTrigger.closest("[data-section-menu]")!);
    act(() => vi.advanceTimersByTime(249));
    expect(secondTrigger.getAttribute("aria-expanded")).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(secondTrigger.getAttribute("aria-expanded")).toBe("false");
  });


  it("opens a closed trigger pinned on ArrowDown and roves its panel links", () => {
    installMatchMediaMock(true);

    render(<TopNav />);

    const trigger = screen.getByRole("button", { name: "Markets" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>('[data-section-menu="markets"] a[href]'),
    ];
    expect(links.length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(links[0]);

    fireEvent.keyDown(links[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[1]);

    fireEvent.keyDown(links[1], { key: "End" });
    expect(document.activeElement).toBe(links[links.length - 1]);

    fireEvent.keyDown(links[links.length - 1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[0]);

    fireEvent.keyDown(links[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(links[links.length - 1]);

    fireEvent.keyDown(links[links.length - 1], { key: "Home" });
    expect(document.activeElement).toBe(links[0]);

    // Keyboard opens are pinned, not hover-dismissable.
    fireEvent.mouseLeave(trigger.closest("[data-section-menu]")!);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("uses disclosure semantics and restores trigger focus on Escape", () => {
    installMatchMediaMock(true);

    render(<TopNav />);

    const menu = NAV_GROUPS.find((group) => !group.columns)!;
    const item = menu.items.find((candidate) => candidate.description)!;
    const trigger = screen.getByRole("button", { name: menu.label });

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const panelId = trigger.getAttribute("aria-controls");
    expect(panelId).not.toBeNull();
    expect(document.getElementById(panelId!)).not.toBeNull();
    expect(document.querySelector('nav[aria-label="Sections"] [role="menu"]')).toBeNull();
    expect(document.querySelector('nav[aria-label="Sections"] [role="menuitem"]')).toBeNull();

    const link = screen.getByRole("link", { name: item.label });
    expect(screen.queryByRole("link", { name: `${item.label} ${item.description}` })).toBeNull();
    const descriptionId = link.getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    const description = document.getElementById(descriptionId!);
    expect(description?.textContent).toBe(item.description);
    expect(description?.getAttribute("aria-hidden")).toBe("true");

    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });


  it("keeps the Status destination label and shows health as separate metadata", () => {
    installMatchMediaMock(true);

    render(<TopNav />);
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    const statusLabel = screen.getByText("Status", { selector: "span" });
    const state = screen.getByText("Operational", { selector: "span" });
    const statusLink = statusLabel.closest("a");
    expect(state.closest("a")).toBe(statusLink);
    expect(statusLink?.querySelector("span.rounded-full")?.classList.contains("bg-state-positive-solid")).toBe(true);
    expect(useHealthMock).toHaveBeenLastCalledWith({ enabled: true });
  });

  it("reports a degraded headline with text and the warning dot", () => {
    installMatchMediaMock(true);
    useHealthMock.mockReturnValue({
      data: { ...makeHealthyHealthResponse(), status: "degraded" },
      isError: false,
    });

    render(<TopNav />);
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    const state = screen.getByText("Degraded", { selector: "span" });
    const dot = state.closest("a")?.querySelector("span.rounded-full");
    expect(dot?.classList.contains("bg-state-warn-solid")).toBe(true);
  });

  it("does not publish retained healthy data after a failed health refetch", () => {
    installMatchMediaMock(true);
    useHealthMock.mockReturnValue({ data: makeHealthyHealthResponse(), isError: true });
    render(<TopNav />);
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(screen.getByText("Unavailable", { selector: "span" })).not.toBeNull();
    expect(screen.queryByText("Operational", { selector: "span" })).toBeNull();
  });

  it("keeps the initial health read neutral while checking", () => {
    installMatchMediaMock(true);
    useHealthMock.mockReturnValue({ data: undefined, isError: false });
    render(<TopNav />);
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(screen.getByText("Checking", { selector: "span" })).not.toBeNull();
    expect(screen.queryByText("Operational", { selector: "span" })).toBeNull();
  });

  it("shows the worker headline label when the payload carries one", () => {
    installMatchMediaMock(true);
    useHealthMock.mockReturnValue({
      data: {
        ...makeHealthyHealthResponse(),
        status: "stale",
        headline: { state: "partial-outage", title: "Partial outage: Yield", affected: ["yield"] },
        components: [],
      },
      isError: false,
    });
    render(<TopNav />);
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(screen.getByText("Partial outage", { selector: "span" })).not.toBeNull();
  });

});
