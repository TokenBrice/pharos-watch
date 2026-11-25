// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopNav } from "@/components/top-nav";
import { CHROME_DISMISS_EVENT, OPEN_KEYBOARD_SHORTCUTS_EVENT } from "@/lib/chrome-popover";
import { DESKTOP_QUICK_NAV_ITEMS, NAV_GROUPS } from "@/lib/nav-config";
import { cleanupFrontendTest } from "@/test-utils/frontend";

const { useHealthMock, useHomepageSnapshotMock, trackEventMock, pathnameMock, hydratedMock } = vi.hoisted(() => ({
  useHealthMock: vi.fn(),
  useHomepageSnapshotMock: vi.fn(() => ({ data: undefined as unknown })),
  trackEventMock: vi.fn(),
  pathnameMock: { current: "/" as string },
  hydratedMock: { current: false },
}));

vi.mock("next/navigation", () => ({ usePathname: () => pathnameMock.current }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => hydratedMock.current }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));
vi.mock("@/components/pharos-logo", () => ({ PharosLogo: () => <span aria-hidden="true" data-testid="pharos-logo" /> }));
vi.mock("@/lib/command-palette", () => ({ OPEN_COMMAND_PALETTE_EVENT: "open-command-palette", openCommandPalette: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ trackEvent: trackEventMock }));
vi.mock("@/components/psi-beacon/regime-bar", () => ({ RegimeBarToggle: () => null }));
vi.mock("@/hooks/api-hooks", () => ({ useHealth: useHealthMock, useHomepageSnapshot: useHomepageSnapshotMock }));

function pointerEnterMouse(element: Element) {
  fireEvent.pointerOver(element, { pointerType: "mouse" });
}

function pointerLeaveMouse(element: Element) {
  fireEvent.pointerOut(element, { pointerType: "mouse" });
}

afterEach(cleanupFrontendTest);

describe("TopNav", () => {
  beforeEach(() => {
    pathnameMock.current = "/";
    hydratedMock.current = false;
    useHealthMock.mockReset();
    trackEventMock.mockReset();
    useHomepageSnapshotMock.mockReturnValue({ data: undefined });
  });

  it("renders the 5-item quick rail without a duplicate Home pill and marks the brand link current on /", () => {
    const { rerender } = render(<TopNav />);

    const brandLink = screen.getByRole("link", { name: "Pharos home" });
    expect(brandLink.getAttribute("aria-current")).toBe("page");

    const primaryNav = screen.getByRole("navigation", { name: "Primary" });
    const railLinks = [...primaryNav.querySelectorAll<HTMLAnchorElement>(":scope > div:first-child a[href]")];
    const stripSlash = (href: string | null) => href?.replace(/(.)\/$/, "$1");
    expect(railLinks.map((link) => stripSlash(link.getAttribute("href")))).toEqual(
      DESKTOP_QUICK_NAV_ITEMS.map((item) => stripSlash(item.href)),
    );
    expect(railLinks.some((link) => link.getAttribute("href") === "/")).toBe(false);

    const stabilityLink = primaryNav.querySelector<HTMLAnchorElement>('a[href^="/stability-index"]')!;
    expect(stabilityLink.textContent).not.toContain("PSI");
    expect(stabilityLink.textContent).toContain("Stability");
    const freezeLink = primaryNav.querySelector<HTMLAnchorElement>('a[href^="/freezewatch"]')!;
    expect(freezeLink.textContent).toContain("Freeze");
    expect(freezeLink.textContent).toContain("FreezeWatch");

    pathnameMock.current = "/compliance/";
    rerender(<TopNav />);
    expect(screen.getByRole("link", { name: "Pharos home" }).getAttribute("aria-current")).toBeNull();
  });

  it("mounts every closed panel hidden and inert with Pharos sections, companion PharosVille, and pure Learn rows", () => {
    render(<TopNav />);
    const stripSlash = (href: string | null) => href?.replace(/(.)\/$/, "$1");

    expect(NAV_GROUPS.map((group) => group.label)).toEqual(["Markets", "Risk", "Tools", "Learn", "Pharos"]);

    for (const menu of NAV_GROUPS) {
      const trigger = screen.getByRole("button", { name: menu.label });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      const panel = document.getElementById(trigger.getAttribute("aria-controls")!);
      expect(panel).not.toBeNull();
      expect([panel!.hidden, panel!.hasAttribute("inert")]).toEqual([true, true]);
      const expectedItems = [...menu.items, ...(menu.quickBarLinks ?? [])];
      const hrefs = [...panel!.querySelectorAll<HTMLAnchorElement>("a[href]")].map((link) => stripSlash(link.getAttribute("href")));
      expect(hrefs).toEqual(expectedItems.map((item) => stripSlash(item.href)));
    }

    expect(screen.queryByRole("link", { name: NAV_GROUPS[0].items[0].label })).toBeNull();
    expect(useHealthMock).not.toHaveBeenCalled();

    // Learn has 4 pure rows with no subheads.
    fireEvent.click(screen.getByRole("button", { name: "Learn" }));
    expect(document.querySelectorAll('[data-section-menu="learn"] p.pharos-label')).toHaveLength(0);
    const learnLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-section-menu="learn"] a[href]')];
    expect(learnLinks).toHaveLength(4);

    // Pharos has Trust & operations (aria-labelledby) + PharosVille companion row with external safeguards.
    const pharosTrigger = screen.getByRole("button", { name: "Pharos" });
    fireEvent.click(pharosTrigger);
    const trustHeading = document.querySelector<HTMLElement>('[data-section-menu="pharos"] p.pharos-label');
    expect(trustHeading?.textContent).toBe("Trust & operations");
    expect(document.querySelector(`[data-section-menu="pharos"] ul[aria-labelledby="${trustHeading!.id}"]`)).not.toBeNull();

    const pharosVilleLink = screen.getByRole("link", { name: "PharosVille (opens in new tab)" });
    expect(pharosVilleLink.getAttribute("target")).toBe("_blank");
    expect(pharosVilleLink.getAttribute("rel")).toBe("noopener noreferrer");
    const desc = document.getElementById(pharosVilleLink.getAttribute("aria-describedby")!);
    expect(desc?.textContent).toBe("Explore the stablecoin universe as a live harbor");
    fireEvent.click(pharosVilleLink);
    expect(trackEventMock).not.toHaveBeenCalled();

    // Internal Pharos link reports nav_click and Status stays neutral without useHealth.
    fireEvent.click(pharosTrigger);
    const statusLink = screen.getByRole("link", { name: "Status" });
    expect(statusLink.textContent).toContain("Status");
    expect(useHealthMock).not.toHaveBeenCalled();
    fireEvent.click(statusLink);
    expect(trackEventMock).toHaveBeenCalledWith("nav_click", {
      surface: "menu",
      group: "pharos",
      href: "/status/",
    });
  });

  it("keeps quick-bar cross-reference links from double-highlighting Markets or Risk triggers", () => {
    const { rerender } = render(<TopNav />);

    for (const [route, sectionLabel] of [
      ["/safety-scores/", "Risk"],
      ["/depeg/", "Risk"],
      ["/yield/", "Markets"],
      ["/stability-index/", "Markets"],
    ] as const) {
      pathnameMock.current = route;
      rerender(<TopNav />);
      const trigger = screen.getByRole("button", { name: sectionLabel });
      expect(trigger.getAttribute("aria-current")).toBeNull();
    }

    pathnameMock.current = "/safety-scores/";
    rerender(<TopNav />);
    fireEvent.click(screen.getByRole("button", { name: "Risk" }));
    expect(document.querySelector('[data-section-menu="risk"] p.pharos-label')?.textContent).toBe("On the quick bar");
    expect(screen.getByRole("link", { name: "Depeg & Recovery" })).toBeTruthy();
  });

  it("handles mouse hover intent, click-to-pin, brief neighbor sweeps, and pinned-menu protection", () => {
    vi.useFakeTimers();
    const dismissSpy = vi.fn();
    window.addEventListener(CHROME_DISMISS_EVENT, dismissSpy);
    try {
      const { container } = render(<TopNav />);
      const header = container.querySelector("header")!;
      expect(header.className).toContain("z-chrome-header");

      const learnMenu = document.querySelector('[data-section-menu="learn"]')!;
      const marketsMenu = document.querySelector('[data-section-menu="markets"]')!;
      const riskMenu = document.querySelector('[data-section-menu="risk"]')!;
      const learnTrigger = screen.getByRole("button", { name: "Learn" });
      const marketsTrigger = screen.getByRole("button", { name: "Markets" });
      const riskTrigger = screen.getByRole("button", { name: "Risk" });

      // Touch pointerEnter never opens hover panels.
      fireEvent.pointerOver(learnMenu, { pointerType: "touch" });
      act(() => vi.advanceTimersByTime(500));
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("false");

      // Mouse hover opens after 350ms and elevates header to z-modal + dismisses other chrome overlays.
      pointerEnterMouse(learnMenu);
      act(() => vi.advanceTimersByTime(349));
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("false");
      act(() => vi.advanceTimersByTime(1));
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(header.className).toContain("z-modal");
      expect(dismissSpy).toHaveBeenCalledTimes(1);

      // Brief neighbor sweep (<100ms) followed by mouse leave must NOT leave Learn stuck open.
      pointerLeaveMouse(learnMenu);
      pointerEnterMouse(marketsMenu);
      act(() => vi.advanceTimersByTime(50));
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(marketsTrigger.getAttribute("aria-expanded")).toBe("false");
      pointerLeaveMouse(marketsMenu);
      act(() => vi.advanceTimersByTime(449));
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("true");
      act(() => vi.advanceTimersByTime(1));
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("false");

      // Clicking a hover-opened trigger pins it open instead of closing it.
      pointerEnterMouse(learnMenu);
      act(() => vi.advanceTimersByTime(350));
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("true");
      fireEvent.pointerDown(learnTrigger);
      fireEvent.click(learnTrigger);
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("true");
      pointerLeaveMouse(learnMenu);
      act(() => vi.advanceTimersByTime(600));
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("true");

      // Hovering a neighbor while click-pinned must NOT hijack the pinned menu.
      pointerEnterMouse(riskMenu);
      act(() => vi.advanceTimersByTime(500));
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(riskTrigger.getAttribute("aria-expanded")).toBe("false");

      // Second click on the pinned trigger toggles it closed.
      fireEvent.pointerDown(learnTrigger);
      fireEvent.click(learnTrigger);
      expect(learnTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(header.className).toContain("z-chrome-header");
    } finally {
      window.removeEventListener(CHROME_DISMISS_EVENT, dismissSpy);
    }
  });

  it("supports ArrowDown/Up/Home/End roving, ArrowLeft/Right trigger switching, and Escape with stopPropagation", () => {
    render(<TopNav />);
    const marketsTrigger = screen.getByRole("button", { name: "Markets" });
    const riskTrigger = screen.getByRole("button", { name: "Risk" });
    const pharosTrigger = screen.getByRole("button", { name: "Pharos" });

    // ArrowLeft/Right moves across triggers even when closed.
    marketsTrigger.focus();
    fireEvent.keyDown(marketsTrigger, { key: "ArrowRight" });
    expect(document.activeElement).toBe(riskTrigger);
    expect(riskTrigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(riskTrigger, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(marketsTrigger);
    fireEvent.keyDown(marketsTrigger, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(pharosTrigger);
    fireEvent.keyDown(pharosTrigger, { key: "ArrowRight" });
    expect(document.activeElement).toBe(marketsTrigger);

    // ArrowDown opens Markets pinned and roves links.
    fireEvent.keyDown(marketsTrigger, { key: "ArrowDown" });
    expect(marketsTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('nav[aria-label="Primary"] [role="menu"], nav[aria-label="Primary"] [role="menuitem"]')).toBeNull();

    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-section-menu="markets"] a[href]')];
    expect(links.length).toBeGreaterThan(1);
    const last = links.length - 1;
    expect(document.activeElement).toBe(links[0]);

    for (const [key, expectedIndex] of [["ArrowDown", 1], ["End", last], ["ArrowDown", 0], ["ArrowUp", last], ["Home", 0]] as const) {
      fireEvent.keyDown(document.activeElement!, { key });
      expect(document.activeElement).toBe(links[expectedIndex]);
    }

    // ArrowRight while open switches to Risk and keeps the adjacent panel open.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(riskTrigger);
    expect(marketsTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(riskTrigger.getAttribute("aria-expanded")).toBe("true");

    // Escape closes Risk, restores focus to trigger, and prevents bubbling to document listeners.
    const docEscapeSpy = vi.fn();
    document.addEventListener("keydown", docEscapeSpy);
    try {
      const riskLink = document.querySelector<HTMLAnchorElement>('[data-section-menu="risk"] a[href]')!;
      riskLink.focus();
      fireEvent.keyDown(riskLink, { key: "Escape" });
      expect(riskTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(riskTrigger);
      expect(docEscapeSpy).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", docEscapeSpy);
    }
  });

  it("badges Depeg with an open-incident count only when > 0", () => {
    const { unmount } = render(<TopNav />);
    const depegLink = () => document.querySelector<HTMLAnchorElement>('nav[aria-label="Primary"] a[href^="/depeg"]')!;
    expect(depegLink().textContent).not.toMatch(/active depeg/);
    unmount();

    useHomepageSnapshotMock.mockReturnValue({ data: { incidents: { data: { activeDepegCount: 18 } } } });
    render(<TopNav />);
    expect(depegLink().textContent).toContain(", 18 active depegs");
    expect(depegLink().querySelector('span[aria-hidden="true"]')?.textContent).toBe("18");
  });

  it("houses ThemeControls and Keyboard shortcuts inside the native Appearance disclosure without role=menu", () => {
    const openShortcutsSpy = vi.fn();
    window.addEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, openShortcutsSpy);
    try {
      const { container } = render(
        <>
          <TopNav />
          <button type="button" data-slot="popover-trigger">Page popover</button>
        </>,
      );

      // Standalone ? trigger is removed from the top bar.
      expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();

      // Clicking a page-level popover trigger closes an open TopNav section menu.
      const marketsTrigger = screen.getByRole("button", { name: "Markets" });
      fireEvent.click(marketsTrigger);
      expect(marketsTrigger.getAttribute("aria-expanded")).toBe("true");
      fireEvent.pointerDown(screen.getByRole("button", { name: "Page popover" }));
      expect(marketsTrigger.getAttribute("aria-expanded")).toBe("false");

      // Open a section menu first, then open Appearance on the very first click.
      fireEvent.click(marketsTrigger);
      expect(marketsTrigger.getAttribute("aria-expanded")).toBe("true");

      const appearanceTrigger = screen.getByRole("button", { name: "Appearance" });
      expect(appearanceTrigger.getAttribute("aria-expanded")).toBe("false");
      fireEvent.pointerDown(appearanceTrigger);
      fireEvent.click(appearanceTrigger);

      expect(marketsTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(appearanceTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector("header")!.className).toContain("z-modal");
      const panel = document.querySelector("[data-top-nav-appearance]")!;
      expect(panel).not.toBeNull();
      expect(panel.getAttribute("role")).toBeNull();
      expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();

      // Escape inside Appearance closes it and restores focus to Appearance trigger.
      const shortcutsButton = screen.getByRole("button", { name: /Keyboard shortcuts/ });
      shortcutsButton.focus();
      fireEvent.keyDown(shortcutsButton, { key: "Escape" });
      expect(appearanceTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(appearanceTrigger);

      // Opening Keyboard shortcuts closes Appearance without stealing focus back.
      fireEvent.click(appearanceTrigger);
      fireEvent.click(screen.getByRole("button", { name: /Keyboard shortcuts/ }));
      expect(openShortcutsSpy).toHaveBeenCalledTimes(1);
      expect(document.querySelector("[data-top-nav-appearance]")).toBeNull();
    } finally {
      window.removeEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, openShortcutsSpy);
    }
  });

  it("keeps the WCAG 2.5.3 search label, xl:w-[10rem] build canary, and OS-aware shortcut badge", () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", configurable: true });
    try {
      const { rerender } = render(<TopNav />);
      const searchBtn = screen.getByRole("button", { name: "Search coin or page" });
      expect(searchBtn.className).toContain("xl:w-[10rem]");
      expect(searchBtn.querySelector("kbd")?.textContent).toBe("Ctrl K");
      const visibleLabels = [...searchBtn.querySelectorAll("span")].map((span) => span.textContent);
      expect(visibleLabels).toEqual(["Search", "Coin or page"]);
      const accessibleName = searchBtn.getAttribute("aria-label")!.toLowerCase();
      for (const visible of visibleLabels) {
        expect(accessibleName).toContain(visible!.toLowerCase());
      }

      hydratedMock.current = true;
      rerender(<TopNav />);
      expect(screen.getByRole("button", { name: "Search coin or page" }).querySelector("kbd")?.textContent).toBe("⌘K");
    } finally {
      Object.defineProperty(navigator, "userAgent", { value: originalUserAgent, configurable: true });
    }
  });
});
