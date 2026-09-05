// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, useContext, type ReactNode } from "react";
import { TopNav } from "@/components/top-nav";
import { NAV_GROUPS, QUICK_NAV_ITEMS, normalizeNavPath } from "@/lib/nav-config";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";
import { makeHealthyHealthResponse } from "@/test-utils/status-fixtures";

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
    useHealthMock.mockReset();
    useHealthMock.mockReturnValue({
      data: makeHealthyHealthResponse(),
      isError: false,
    });
  });

  it("promotes the configured quick routes to direct links", () => {
    installMatchMediaMock(true);

    render(<TopNav />);

    const rail = document.querySelector('nav[aria-label="Quick links"]');
    const railLinks = [...(rail?.querySelectorAll("a") ?? [])];

    expect(railLinks.map((link) => normalizeNavPath(link.getAttribute("href") ?? ""))).toEqual(
      QUICK_NAV_ITEMS.map((item) => normalizeNavPath(item.href)),
    );
    expect(railLinks.every((link) => link.querySelector("svg") !== null)).toBe(true);
    expect(railLinks[0].getAttribute("aria-current")).toBe("page");
  });

  it("keeps compact rail labels through xl while expanding entity search", () => {
    installMatchMediaMock(true);

    render(<TopNav />);

    const compactItem = QUICK_NAV_ITEMS.find((item) => item.shortLabel && item.shortLabel !== item.label);
    expect(compactItem).toBeDefined();
    const compactLink = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Quick links"] a')].find(
      (link) => normalizeNavPath(link.getAttribute("href") ?? "") === normalizeNavPath(compactItem!.href),
    )!;
    const compactLabel = [...compactLink.querySelectorAll("span")].find((node) => node.classList.contains("2xl:hidden"));
    const fullLabel = [...compactLink.querySelectorAll("span")].find((node) => node.classList.contains("2xl:inline"));
    const search = screen.getByRole("button", { name: "Search" });

    expect(compactLabel?.textContent).toBe(compactItem!.shortLabel);
    expect(fullLabel?.textContent).toBe(compactItem!.label);
    // Assert the breakpoint contract, not the width literal: the search
    // control expands one breakpoint before the rail gives up its shorthand,
    // and the exact xl width is a fitting detail that has already had to move
    // once to stop the masthead overflowing at 1280.
    expect(search.className).toContain("xl:justify-start");
    expect(screen.getByText("Coin or page").className).toContain("xl:inline");
    expect(screen.getByText("⌘K").className).toContain("xl:inline");
  });

  it("opens Resources only after hover intent and renders its configured columns", () => {
    vi.useFakeTimers();
    const matchMedia = installMatchMediaMock(true);

    render(<TopNav />);

    expect(matchMedia).toHaveBeenCalledWith("(hover: hover) and (pointer: fine)");
    const trigger = screen.getByRole("button", { name: "Resources" });
    fireEvent.mouseEnter(trigger);

    act(() => vi.advanceTimersByTime(249));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    act(() => vi.advanceTimersByTime(1));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const resources = NAV_GROUPS.find((menu) => menu.key === "more");
    const columnHeadings = [...document.querySelectorAll("p.pharos-kicker")].map((node) => node.textContent);
    expect(columnHeadings).toEqual(resources?.columns?.map((column) => column.label));
    expect(useHealthMock).toHaveBeenLastCalledWith({ enabled: true });

    const hoverBridge = document.querySelector('[data-section-menu="more"] > div.absolute');
    expect(hoverBridge?.className).toContain("pt-2");
  });

  it("switches an open hover panel after 100ms and closes after 250ms", () => {
    vi.useFakeTimers();
    installMatchMediaMock(true);

    render(<TopNav />);

    const [firstMenu, secondMenu] = NAV_GROUPS;
    const firstTrigger = screen.getByRole("button", { name: firstMenu.label });
    const secondTrigger = screen.getByRole("button", { name: secondMenu.label });

    fireEvent.mouseEnter(firstTrigger);
    act(() => vi.advanceTimersByTime(250));
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
    const state = screen.getByText("Healthy", { selector: "span" });
    const statusLink = statusLabel.closest("a");
    expect(state.closest("a")).toBe(statusLink);
    expect(statusLink?.querySelector("span.rounded-full")?.classList.contains("bg-[var(--severity-healthy)]")).toBe(true);
    expect(screen.queryByText("Pharos is Healthy")).toBeNull();
    expect(useHealthMock).toHaveBeenLastCalledWith({ enabled: true });
  });

  it("reports degraded health with text and the mild-severity dot", () => {
    installMatchMediaMock(true);
    useHealthMock.mockReturnValue({
      data: { ...makeHealthyHealthResponse(), status: "degraded" },
      isError: false,
    });

    render(<TopNav />);
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    const state = screen.getByText("Degraded", { selector: "span" });
    const dot = state.closest("a")?.querySelector("span.rounded-full");
    expect(dot?.classList.contains("bg-[var(--severity-mild)]")).toBe(true);
  });

  it("uses readable unavailable metadata when public health cannot be loaded", () => {
    installMatchMediaMock(true);
    useHealthMock.mockReturnValue({ data: undefined, isError: true });

    render(<TopNav />);
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Status", { selector: "span" })).not.toBeNull();
    expect(screen.getByText("Unavailable", { selector: "span" })).not.toBeNull();
  });
});
