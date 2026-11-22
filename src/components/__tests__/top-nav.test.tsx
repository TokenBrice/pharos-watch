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

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.current,
}));

vi.mock("@/hooks/use-hydrated", () => ({
  useHydrated: () => hydratedMock.current,
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

vi.mock("@/components/psi-beacon/regime-bar", () => ({
  RegimeBarToggle: () => null,
}));

vi.mock("@/hooks/api-hooks", () => ({
  useHealth: useHealthMock,
  useHomepageSnapshot: useHomepageSnapshotMock,
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
    hydratedMock.current = false;
    useHealthMock.mockReset();
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
    expect(useHealthMock).not.toHaveBeenCalled();

    const trigger = screen.getByRole("button", { name: NAV_GROUPS[0].label });
    fireEvent.click(trigger);
    const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(false);
    expect(panel.hasAttribute("inert")).toBe(false);
  });

  it("stacks above page-level sticky bars so an open panel is never covered", () => {
    installMatchMediaMock(true);

    render(<TopNav />);

    const header = screen.getByRole("banner", { name: "Primary" });
    expect(header.className).toContain("z-chrome-header");
  });

  it("opens Learn only after hover intent and closes its panel on the compact tier", () => {
    vi.useFakeTimers();
    const matchMedia = installMatchMediaMock(true);

    render(<TopNav />);
    expect(matchMedia).toHaveBeenCalledWith("(hover: hover) and (pointer: fine)");
    const trigger = screen.getByRole("button", { name: "Learn" });

    fireEvent.mouseEnter(trigger);

    act(() => vi.advanceTimersByTime(349));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    act(() => vi.advanceTimersByTime(1));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const learn = NAV_GROUPS.find((menu) => menu.key === "learn")!;
    const subheads = [...document.querySelectorAll('[data-section-menu="learn"] p.pharos-label')].map((node) => node.textContent);
    expect(subheads).toEqual(learn.sections!.filter((section) => section.label).map((section) => section.label));
    // Compact rows keep their description as a tooltip, not a second line.
    const compact = learn.sections!.find((section) => section.compact)!.items.find((item) => !item.external)!;
    const compactLink = screen.getByRole("link", { name: compact.label });
    expect([compactLink.getAttribute("title"), compactLink.getAttribute("aria-describedby")]).toEqual([compact.description, null]);
    expect(useHealthMock).not.toHaveBeenCalled();

    const hoverBridge = document.querySelector('[data-section-menu="learn"] > div.absolute');
    expect(hoverBridge?.className).toContain("pt-2");
  });

  it("opens after 350ms from closed, switches after 100ms, and closes after 450ms", () => {
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
    act(() => vi.advanceTimersByTime(449));
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

    const menu = NAV_GROUPS.find((group) => !group.sections)!;
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


  it("badges Depeg with a neutral open-incident count once read", () => {
    installMatchMediaMock(true);
    const { unmount } = render(<TopNav />);
    const depegLink = () => document.querySelector<HTMLAnchorElement>('nav[aria-label="Quick links"] a[href^="/depeg"]')!;
    expect(depegLink().textContent).not.toMatch(/active depeg/);
    unmount();

    useHomepageSnapshotMock.mockReturnValue({ data: { incidents: { data: { activeDepegCount: 18 } } } });
    render(<TopNav />);
    expect(depegLink().textContent).toContain(", 18 active depegs");
    const badge = depegLink().querySelector('[aria-hidden="true"].rounded-full')!;
    // Neutral: some incidents are always open.
    expect([badge.textContent, /red|danger|amber|warn/.test(badge.className)]).toEqual(["18", false]);
    useHomepageSnapshotMock.mockReturnValue({ data: undefined });
  });

  it("keeps the Status link a neutral destination with no health metadata", () => {
    installMatchMediaMock(true);

    render(<TopNav />);
    fireEvent.click(screen.getByRole("button", { name: "Learn" }));

    const statusLink = screen.getByText("Status", { selector: "span" }).closest("a");
    expect(statusLink?.textContent).toBe("Status");
    expect(statusLink?.querySelector("span.rounded-full")).toBeNull();
    expect(useHealthMock).not.toHaveBeenCalled();
  });

  it("steps Stability and FreezeWatch labels in at xl, unifies active pills, and includes Documentation in Learn", () => {
    installMatchMediaMock(true);
    pathnameMock.current = "/compliance/";
    render(<TopNav />);

    const stabilityLink = document.querySelector<HTMLAnchorElement>('nav[aria-label="Quick links"] a[href^="/stability-index"]')!;
    const compactTier = stabilityLink.querySelector("span.xl\\:hidden");
    const shortTier = stabilityLink.querySelector("span.xl\\:inline");
    expect(compactTier?.textContent).toBe("PSI");
    expect(shortTier?.textContent).toBe("Stability");

    const freezeLink = document.querySelector<HTMLAnchorElement>('nav[aria-label="Quick links"] a[href^="/freezewatch"]')!;
    expect(freezeLink.querySelector("span.xl\\:hidden")?.textContent).toBe("Freeze");
    expect(freezeLink.querySelector("span.xl\\:inline")?.textContent).toBe("FreezeWatch");

    // Active section dropdown shares the Stage 1D dark-mode active pill grammar.
    const riskTrigger = screen.getByRole("button", { name: "Risk" });
    expect(riskTrigger.className).toContain("dark:bg-card");
    expect(riskTrigger.className).toContain("dark:ring-1");
    expect(riskTrigger.className).toContain("dark:ring-border/80");

    // Utility divider separates sections from utility controls.
    expect(document.querySelector('span[aria-hidden="true"].h-4.w-px')).not.toBeNull();

    // Learn includes Documentation (/docs/) and Alert Bot description omits stale "launches".
    const learn = NAV_GROUPS.find((group) => group.key === "learn")!;
    expect(learn.items.some((item) => item.href === "/docs/" && item.label === "Documentation")).toBe(true);
    const tools = NAV_GROUPS.find((group) => group.key === "tools")!;
    const alertBot = tools.items.find((item) => item.href === "/pharoswatchbot/");
    expect(alertBot?.description).toBeTruthy();
    expect(alertBot?.description?.toLowerCase()).not.toContain("launches");
  });

  it("renders OS-aware hydration-safe search shortcut badges and triggers keyboard shortcuts from ?", () => {
    installMatchMediaMock(true);
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      configurable: true,
    });

    try {
      // Before hydration: SSR-safe Ctrl K default.
      const { rerender } = render(<TopNav />);
      const searchBtn = screen.getByRole("button", { name: "Search" });
      expect(searchBtn.querySelector("kbd")?.textContent).toBe("Ctrl K");

      // After hydration on Apple user agent: switches to ⌘K.
      hydratedMock.current = true;
      rerender(<TopNav />);
      expect(screen.getByRole("button", { name: "Search" }).querySelector("kbd")?.textContent).toBe("⌘K");

      // ? trigger dispatches the global shortcuts keydown on non-editorial routes.
      const onKeyDown = vi.fn();
      window.addEventListener("keydown", onKeyDown);
      fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
      expect(onKeyDown).toHaveBeenCalledTimes(1);
      expect((onKeyDown.mock.calls[0]![0] as KeyboardEvent).key).toBe("?");
      window.removeEventListener("keydown", onKeyDown);

      // Editorial routes omit the ? trigger because InteractiveProviders is not mounted there.
      pathnameMock.current = "/about/";
      rerender(<TopNav />);
      expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        value: originalUserAgent,
        configurable: true,
      });
    }
  });

});
