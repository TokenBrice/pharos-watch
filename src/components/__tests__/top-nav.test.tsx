// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, useContext, type ReactNode } from "react";
import { TopNav } from "@/components/top-nav";
import { NAV_GROUPS } from "@/lib/nav-config";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";

const { useHealthMock, useHomepageSnapshotMock, pathnameMock, hydratedMock } = vi.hoisted(() => ({
  useHealthMock: vi.fn(),
  useHomepageSnapshotMock: vi.fn(() => ({ data: undefined as unknown })),
  pathnameMock: { current: "/" as string },
  hydratedMock: { current: false },
}));

vi.mock("next/navigation", () => ({ usePathname: () => pathnameMock.current }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => hydratedMock.current }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));
vi.mock("@/components/pharos-logo", () => ({ PharosLogo: () => <span aria-hidden="true" data-testid="pharos-logo" /> }));
vi.mock("@/lib/command-palette", () => ({ openCommandPalette: vi.fn() }));
vi.mock("@/components/psi-beacon/regime-bar", () => ({ RegimeBarToggle: () => null }));
vi.mock("@/hooks/api-hooks", () => ({ useHealth: useHealthMock, useHomepageSnapshot: useHomepageSnapshotMock }));

const DropdownOpenContext = createContext(false);
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children, open = false }: { children: ReactNode; open?: boolean }) => (
    <DropdownOpenContext.Provider value={open}>{children}</DropdownOpenContext.Provider>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (useContext(DropdownOpenContext) ? <div role="menu">{children}</div> : null),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div role="menuitem">{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

afterEach(cleanupFrontendTest);

describe("TopNav", () => {
  let matchMediaMock: ReturnType<typeof installMatchMediaMock>;

  beforeEach(() => {
    pathnameMock.current = "/";
    hydratedMock.current = false;
    useHealthMock.mockReset();
    useHomepageSnapshotMock.mockReturnValue({ data: undefined });
    matchMediaMock = installMatchMediaMock(true);
  });

  it("mounts every closed panel hidden and inert so its links are crawlable but not focusable", () => {
    render(<TopNav />);
    const stripSlash = (href: string | null) => href?.replace(/(.)\/$/, "$1");

    for (const menu of NAV_GROUPS) {
      const trigger = screen.getByRole("button", { name: menu.label });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      const panel = document.getElementById(trigger.getAttribute("aria-controls")!);
      expect(panel).not.toBeNull();
      expect([panel!.hidden, panel!.hasAttribute("inert")]).toEqual([true, true]);
      const hrefs = [...panel!.querySelectorAll<HTMLAnchorElement>("a[href]")].map((link) => stripSlash(link.getAttribute("href")));
      expect(hrefs).toEqual(menu.items.map((item) => stripSlash(item.href)));
    }
    expect(screen.queryByRole("link", { name: NAV_GROUPS[0].items[0].label })).toBeNull();
    expect(screen.queryByText("Operational", { selector: "span" })).toBeNull();
    expect(useHealthMock).not.toHaveBeenCalled();

    const trigger = screen.getByRole("button", { name: NAV_GROUPS[0].label });
    fireEvent.click(trigger);
    const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect([panel.hidden, panel.hasAttribute("inert")]).toEqual([false, false]);
  });

  it("opens Learn after 350ms hover intent, switches after 100ms, closes after 450ms, and keeps compact rows tooltip-described", () => {
    vi.useFakeTimers();
    render(<TopNav />);
    expect(matchMediaMock).toHaveBeenCalledWith("(hover: hover) and (pointer: fine)");

    const learnTrigger = screen.getByRole("button", { name: "Learn" });
    fireEvent.mouseEnter(learnTrigger);
    act(() => vi.advanceTimersByTime(349));
    expect(learnTrigger.getAttribute("aria-expanded")).toBe("false");
    act(() => vi.advanceTimersByTime(1));
    expect(learnTrigger.getAttribute("aria-expanded")).toBe("true");

    const learn = NAV_GROUPS.find((menu) => menu.key === "learn")!;
    const subheads = [...document.querySelectorAll('[data-section-menu="learn"] p.pharos-label')].map((node) => node.textContent);
    expect(subheads).toEqual(learn.sections!.filter((s) => s.label).map((s) => s.label));
    const compact = learn.sections!.find((s) => s.compact)!.items.find((item) => !item.external)!;
    const compactLink = screen.getByRole("link", { name: compact.label });
    expect([compactLink.getAttribute("title"), compactLink.getAttribute("aria-describedby")]).toEqual([compact.description, null]);
    expect(useHealthMock).not.toHaveBeenCalled();

    const nextTrigger = screen.getByRole("button", { name: NAV_GROUPS[0].label });
    fireEvent.mouseLeave(learnTrigger.closest("[data-section-menu]")!);
    fireEvent.mouseEnter(nextTrigger);
    act(() => vi.advanceTimersByTime(99));
    expect(learnTrigger.getAttribute("aria-expanded")).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(nextTrigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseLeave(nextTrigger.closest("[data-section-menu]")!);
    act(() => vi.advanceTimersByTime(449));
    expect(nextTrigger.getAttribute("aria-expanded")).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(nextTrigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a closed trigger pinned on ArrowDown and roves its panel links", () => {
    render(<TopNav />);
    const trigger = screen.getByRole("button", { name: "Markets" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-section-menu="markets"] a[href]')];
    expect(links.length).toBeGreaterThan(1);
    const last = links.length - 1;
    expect(document.activeElement).toBe(links[0]);

    for (const [key, expectedIndex] of [["ArrowDown", 1], ["End", last], ["ArrowDown", 0], ["ArrowUp", last], ["Home", 0]] as const) {
      fireEvent.keyDown(document.activeElement!, { key });
      expect(document.activeElement).toBe(links[expectedIndex]);
    }
    // Keyboard opens are pinned, not hover-dismissable.
    fireEvent.mouseLeave(trigger.closest("[data-section-menu]")!);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("uses disclosure semantics and restores trigger focus on Escape", () => {
    render(<TopNav />);
    const menu = NAV_GROUPS.find((group) => !group.sections)!;
    const item = menu.items.find((candidate) => candidate.description)!;
    const trigger = screen.getByRole("button", { name: menu.label });

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(trigger.getAttribute("aria-controls")!)).not.toBeNull();
    expect(document.querySelector('nav[aria-label="Sections"] [role="menu"], nav[aria-label="Sections"] [role="menuitem"]')).toBeNull();

    const link = screen.getByRole("link", { name: item.label });
    expect(screen.queryByRole("link", { name: `${item.label} ${item.description}` })).toBeNull();
    const description = document.getElementById(link.getAttribute("aria-describedby")!);
    expect([description?.textContent, description?.getAttribute("aria-hidden")]).toEqual([item.description, "true"]);

    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("badges Depeg with an open-incident count and keeps Status a neutral link without health metadata", () => {
    const { unmount } = render(<TopNav />);
    const depegLink = () => document.querySelector<HTMLAnchorElement>('nav[aria-label="Quick links"] a[href^="/depeg"]')!;
    expect(depegLink().textContent).not.toMatch(/active depeg/);
    unmount();

    useHomepageSnapshotMock.mockReturnValue({ data: { incidents: { data: { activeDepegCount: 18 } } } });
    render(<TopNav />);
    expect(depegLink().textContent).toContain(", 18 active depegs");
    expect(depegLink().querySelector('span[aria-hidden="true"]')?.textContent).toBe("18");

    fireEvent.click(screen.getByRole("button", { name: "Learn" }));
    const statusLink = screen.getByText("Status", { selector: "span" }).closest("a");
    expect(statusLink?.textContent).toBe("Status");
    expect(useHealthMock).not.toHaveBeenCalled();
  });

  it("exposes Stability/FreezeWatch labels and Documentation in Learn", () => {
    pathnameMock.current = "/compliance/";
    render(<TopNav />);

    const stabilityLink = document.querySelector<HTMLAnchorElement>('nav[aria-label="Quick links"] a[href^="/stability-index"]')!;
    expect(stabilityLink.textContent).toContain("PSI");
    expect(stabilityLink.textContent).toContain("Stability");
    const freezeLink = document.querySelector<HTMLAnchorElement>('nav[aria-label="Quick links"] a[href^="/freezewatch"]')!;
    expect(freezeLink.textContent).toContain("Freeze");
    expect(freezeLink.textContent).toContain("FreezeWatch");

    const learn = NAV_GROUPS.find((group) => group.key === "learn")!;
    expect(learn.items.some((item) => item.href === "/docs/" && item.label === "Documentation")).toBe(true);
    const alertBot = NAV_GROUPS.find((group) => group.key === "tools")!.items.find((item) => item.href === "/pharoswatchbot/");
    expect(alertBot?.description).toBeTruthy();
    expect(alertBot?.description?.toLowerCase()).not.toContain("launches");
  });

  it("renders OS-aware hydration-safe search shortcut badges and triggers keyboard shortcuts from ?", () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", configurable: true });
    try {
      const { rerender } = render(<TopNav />);
      const searchBtn = screen.getByRole("button", { name: "Search" });
      expect(searchBtn.querySelector("kbd")?.textContent).toBe("Ctrl K");
      expect([...searchBtn.querySelectorAll("span")].map((span) => span.textContent)).toEqual(["Search", "Coin or page"]);

      hydratedMock.current = true;
      rerender(<TopNav />);
      expect(screen.getByRole("button", { name: "Search" }).querySelector("kbd")?.textContent).toBe("⌘K");

      const onKeyDown = vi.fn();
      window.addEventListener("keydown", onKeyDown);
      fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
      expect(onKeyDown).toHaveBeenCalledTimes(1);
      expect((onKeyDown.mock.calls[0]![0] as KeyboardEvent).key).toBe("?");
      window.removeEventListener("keydown", onKeyDown);

      pathnameMock.current = "/about/";
      rerender(<TopNav />);
      expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
    } finally {
      Object.defineProperty(navigator, "userAgent", { value: originalUserAgent, configurable: true });
    }
  });
});
