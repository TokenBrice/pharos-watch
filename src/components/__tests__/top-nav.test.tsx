// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopNav } from "@/components/top-nav";
import { CHROME_DISMISS_EVENT, OPEN_KEYBOARD_SHORTCUTS_EVENT } from "@/lib/chrome-popover";
import { DESKTOP_QUICK_NAV_ITEMS, NAV_GROUPS } from "@/lib/nav-config";
import { cleanupFrontendTest } from "@/test-utils/frontend";

const { useHealthMock, useHomepageSnapshotMock, trackEventMock, pathnameMock, hydratedMock } = vi.hoisted(() => ({
  useHealthMock: vi.fn(), useHomepageSnapshotMock: vi.fn(() => ({ data: undefined as unknown })),
  trackEventMock: vi.fn(), pathnameMock: { current: "/" as string }, hydratedMock: { current: false },
}));

vi.mock("next/navigation", () => ({ usePathname: () => pathnameMock.current }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => hydratedMock.current }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));
vi.mock("@/components/pharos-logo", () => ({ PharosLogo: () => <span aria-hidden="true" data-testid="pharos-logo" /> }));
vi.mock("@/lib/command-palette", () => ({ OPEN_COMMAND_PALETTE_EVENT: "open-command-palette", openCommandPalette: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ trackEvent: trackEventMock }));
vi.mock("@/components/psi-beacon/regime-bar", () => ({ RegimeBarToggle: () => null }));
vi.mock("@/hooks/api-hooks", () => ({ useHealth: useHealthMock, useHomepageSnapshot: useHomepageSnapshotMock }));

const pointerEnterMouse = (el: Element) => fireEvent.pointerOver(el, { pointerType: "mouse" });
const pointerLeaveMouse = (el: Element) => fireEvent.pointerOut(el, { pointerType: "mouse" });
const expanded = (el: Element) => el.getAttribute("aria-expanded");
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const btn = (name: string | RegExp) => screen.getByRole("button", { name });
const lnk = (name: string | RegExp) => screen.getByRole("link", { name });
const key = (el: Element, k: string) => fireEvent.keyDown(el, { key: k });

afterEach(cleanupFrontendTest);

describe("TopNav", () => {
  beforeEach(() => {
    pathnameMock.current = "/"; hydratedMock.current = false;
    useHealthMock.mockReset(); trackEventMock.mockReset();
    useHomepageSnapshotMock.mockReturnValue({ data: undefined });
  });

  it("renders the 5-item quick rail without a duplicate Home pill and marks the brand link current on /", () => {
    const { rerender } = render(<TopNav />);
    expect(lnk("Pharos home").getAttribute("aria-current")).toBe("page");
    const primaryNav = screen.getByRole("navigation", { name: "Primary" });
    const railLinks = [...primaryNav.querySelectorAll<HTMLAnchorElement>(":scope > div:first-child a[href]")];
    const stripSlash = (href: string | null) => href?.replace(/(.)\/$/, "$1");
    expect(railLinks.map((l) => stripSlash(l.getAttribute("href")))).toEqual(DESKTOP_QUICK_NAV_ITEMS.map((i) => stripSlash(i.href)));
    expect(railLinks.some((l) => l.getAttribute("href") === "/")).toBe(false);
    const stability = primaryNav.querySelector<HTMLAnchorElement>('a[href^="/stability-index"]')!;
    expect(stability.textContent).not.toContain("PSI");
    expect(stability.textContent).toContain("Stability");
    const freeze = primaryNav.querySelector<HTMLAnchorElement>('a[href^="/freezewatch"]')!;
    expect(freeze.textContent).toContain("Freeze");
    expect(freeze.textContent).toContain("FreezeWatch");
    pathnameMock.current = "/compliance/";
    rerender(<TopNav />);
    expect(lnk("Pharos home").getAttribute("aria-current")).toBeNull();
  });

  it("mounts every closed panel hidden and inert with Pharos sections, companion PharosVille, and pure Learn rows", () => {
    render(<TopNav />);
    const stripSlash = (href: string | null) => href?.replace(/(.)\/$/, "$1");
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(["Markets", "Risk", "Tools", "Learn", "Pharos"]);
    for (const menu of NAV_GROUPS) {
      const trigger = btn(menu.label);
      expect(expanded(trigger)).toBe("false");
      const panel = document.getElementById(trigger.getAttribute("aria-controls")!);
      expect(panel).not.toBeNull();
      expect([panel!.hidden, panel!.hasAttribute("inert")]).toEqual([true, true]);
      const expected = [...menu.items, ...(menu.quickBarLinks ?? [])];
      expect([...panel!.querySelectorAll<HTMLAnchorElement>("a[href]")].map((l) => stripSlash(l.getAttribute("href")))).toEqual(expected.map((i) => stripSlash(i.href)));
    }
    expect(screen.queryByRole("link", { name: NAV_GROUPS[0].items[0].label })).toBeNull();
    expect(useHealthMock).not.toHaveBeenCalled();
    fireEvent.click(btn("Learn"));
    expect(document.querySelectorAll('[data-section-menu="learn"] p.pharos-label')).toHaveLength(0);
    expect([...document.querySelectorAll<HTMLAnchorElement>('[data-section-menu="learn"] a[href]')]).toHaveLength(5);
    const pharosTrigger = btn("Pharos");
    fireEvent.click(pharosTrigger);
    const trustHeading = document.querySelector<HTMLElement>('[data-section-menu="pharos"] p.pharos-label');
    expect(trustHeading?.textContent).toBe("Trust & operations");
    expect(document.querySelector(`[data-section-menu="pharos"] ul[aria-labelledby="${trustHeading!.id}"]`)).not.toBeNull();
    const pharosVille = lnk("PharosVille (opens in new tab)");
    expect(pharosVille.getAttribute("target")).toBe("_blank");
    expect(pharosVille.getAttribute("rel")).toBe("noopener noreferrer");
    expect(document.getElementById(pharosVille.getAttribute("aria-describedby")!)?.textContent).toBe("Explore the stablecoin universe as a live harbor");
    fireEvent.click(pharosVille);
    expect(trackEventMock).not.toHaveBeenCalled();
    fireEvent.click(pharosTrigger);
    const status = lnk("Status");
    expect(status.textContent).toContain("Status");
    expect(useHealthMock).not.toHaveBeenCalled();
    fireEvent.click(status);
    expect(trackEventMock).toHaveBeenCalledWith("nav_click", { surface: "menu", group: "pharos", href: "/status/" });
  });

  it("keeps quick-bar cross-reference links from double-highlighting Markets or Risk triggers", () => {
    const { rerender } = render(<TopNav />);
    for (const [route, sectionLabel] of [["/safety-scores/", "Risk"], ["/depeg/", "Risk"], ["/yield/", "Markets"], ["/stability-index/", "Markets"]] as const) {
      pathnameMock.current = route; rerender(<TopNav />);
      expect(btn(sectionLabel).getAttribute("aria-current")).toBeNull();
    }
    pathnameMock.current = "/safety-scores/"; rerender(<TopNav />);
    fireEvent.click(btn("Risk"));
    expect(document.querySelector('[data-section-menu="risk"] p.pharos-label')?.textContent).toBe("On the quick bar");
    expect(lnk("Depeg & Recovery")).toBeTruthy();
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
      const learnTrigger = btn("Learn"), marketsTrigger = btn("Markets"), riskTrigger = btn("Risk");
      fireEvent.pointerOver(learnMenu, { pointerType: "touch" }); tick(500);
      expect(expanded(learnTrigger)).toBe("false");
      pointerEnterMouse(learnMenu); tick(349); expect(expanded(learnTrigger)).toBe("false");
      tick(1); expect(expanded(learnTrigger)).toBe("true");
      expect(header.className).toContain("z-modal");
      expect(dismissSpy).toHaveBeenCalledTimes(1);
      pointerLeaveMouse(learnMenu); pointerEnterMouse(marketsMenu); tick(50);
      expect(expanded(learnTrigger)).toBe("true"); expect(expanded(marketsTrigger)).toBe("false");
      pointerLeaveMouse(marketsMenu); tick(449); expect(expanded(learnTrigger)).toBe("true");
      tick(1); expect(expanded(learnTrigger)).toBe("false");
      pointerEnterMouse(learnMenu); tick(350); expect(expanded(learnTrigger)).toBe("true");
      fireEvent.pointerDown(learnTrigger); fireEvent.click(learnTrigger);
      expect(expanded(learnTrigger)).toBe("true");
      pointerLeaveMouse(learnMenu); tick(600); expect(expanded(learnTrigger)).toBe("true");
      pointerEnterMouse(riskMenu); tick(500);
      expect(expanded(learnTrigger)).toBe("true"); expect(expanded(riskTrigger)).toBe("false");
      fireEvent.pointerDown(learnTrigger); fireEvent.click(learnTrigger);
      expect(expanded(learnTrigger)).toBe("false");
      expect(header.className).toContain("z-chrome-header");
    } finally { window.removeEventListener(CHROME_DISMISS_EVENT, dismissSpy); }
  });

  it("supports ArrowDown/Up/Home/End roving, ArrowLeft/Right trigger switching, and Escape with stopPropagation", () => {
    render(<TopNav />);
    const marketsTrigger = btn("Markets"), riskTrigger = btn("Risk"), pharosTrigger = btn("Pharos");
    marketsTrigger.focus();
    key(marketsTrigger, "ArrowRight"); expect(document.activeElement).toBe(riskTrigger); expect(expanded(riskTrigger)).toBe("false");
    key(riskTrigger, "ArrowLeft"); expect(document.activeElement).toBe(marketsTrigger);
    key(marketsTrigger, "ArrowLeft"); expect(document.activeElement).toBe(pharosTrigger);
    key(pharosTrigger, "ArrowRight"); expect(document.activeElement).toBe(marketsTrigger);
    key(marketsTrigger, "ArrowDown"); expect(expanded(marketsTrigger)).toBe("true");
    expect(document.querySelector('nav[aria-label="Primary"] [role="menu"], nav[aria-label="Primary"] [role="menuitem"]')).toBeNull();
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-section-menu="markets"] a[href]')];
    expect(links.length).toBeGreaterThan(1);
    const last = links.length - 1;
    expect(document.activeElement).toBe(links[0]);
    for (const [k, expectedIndex] of [["ArrowDown", 1], ["End", last], ["ArrowDown", 0], ["ArrowUp", last], ["Home", 0]] as const) {
      key(document.activeElement!, k);
      expect(document.activeElement).toBe(links[expectedIndex]);
    }
    key(document.activeElement!, "ArrowRight");
    expect(document.activeElement).toBe(riskTrigger); expect(expanded(marketsTrigger)).toBe("false"); expect(expanded(riskTrigger)).toBe("true");
    const docEscapeSpy = vi.fn(); document.addEventListener("keydown", docEscapeSpy);
    try {
      const riskLink = document.querySelector<HTMLAnchorElement>('[data-section-menu="risk"] a[href]')!;
      riskLink.focus(); key(riskLink, "Escape");
      expect(expanded(riskTrigger)).toBe("false"); expect(document.activeElement).toBe(riskTrigger); expect(docEscapeSpy).not.toHaveBeenCalled();
    } finally { document.removeEventListener("keydown", docEscapeSpy); }
  });

  it("badges Depeg with an open-incident count only when > 0", () => {
    const { unmount } = render(<TopNav />);
    const depegLink = () => document.querySelector<HTMLAnchorElement>('nav[aria-label="Primary"] a[href^="/depeg"]')!;
    expect(depegLink().textContent).not.toMatch(/recent depeg|active depeg/);
    unmount();

    for (const [data, pill, sr] of [
      [{ activeDepegCount: 18, recentActiveDepegCount: 18, longRunningActiveDepegCount: 0 }, "18", ", 18 recent depegs"],
      [{ activeDepegCount: 18, recentActiveDepegCount: 3, longRunningActiveDepegCount: 15 }, "3", ", 3 recent depegs, 15 long-running"],
      [{ activeDepegCount: 15, recentActiveDepegCount: 0, longRunningActiveDepegCount: 15 }, null, ", 0 recent, 15 long-running active depegs"],
      [{ activeDepegCount: 18 }, null, null],
    ] as const) {
      useHomepageSnapshotMock.mockReturnValue({ data: { incidents: { data } } });
      const v = render(<TopNav />);
      expect(depegLink().querySelector('span[aria-hidden="true"]')?.textContent ?? null).toBe(pill);
      expect(depegLink().querySelector(".sr-only")?.textContent ?? null).toBe(sr);
      v.unmount();
    }
  });

  it("houses ThemeControls and Keyboard shortcuts inside the native Appearance disclosure without role=menu", () => {
    const openShortcutsSpy = vi.fn();
    window.addEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, openShortcutsSpy);
    try {
      const { container } = render(<><TopNav /><button type="button" data-slot="popover-trigger">Page popover</button></>);
      expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
      const marketsTrigger = btn("Markets");
      fireEvent.click(marketsTrigger); expect(expanded(marketsTrigger)).toBe("true");
      fireEvent.pointerDown(btn("Page popover")); expect(expanded(marketsTrigger)).toBe("false");
      fireEvent.click(marketsTrigger); expect(expanded(marketsTrigger)).toBe("true");
      const appearanceTrigger = btn("Appearance");
      expect(expanded(appearanceTrigger)).toBe("false");
      fireEvent.pointerDown(appearanceTrigger); fireEvent.click(appearanceTrigger);
      expect(expanded(marketsTrigger)).toBe("false"); expect(expanded(appearanceTrigger)).toBe("true");
      expect(container.querySelector("header")!.className).toContain("z-modal");
      const panel = document.querySelector("[data-top-nav-appearance]")!;
      expect(panel).not.toBeNull(); expect(panel.getAttribute("role")).toBeNull();
      expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();
      const shortcutsButton = btn(/Keyboard shortcuts/);
      shortcutsButton.focus(); key(shortcutsButton, "Escape");
      expect(expanded(appearanceTrigger)).toBe("false"); expect(document.activeElement).toBe(appearanceTrigger);
      fireEvent.click(appearanceTrigger); fireEvent.click(btn(/Keyboard shortcuts/));
      expect(openShortcutsSpy).toHaveBeenCalledTimes(1);
      expect(document.querySelector("[data-top-nav-appearance]")).toBeNull();
    } finally { window.removeEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, openShortcutsSpy); }
  });

  it("keeps the WCAG 2.5.3 search label, xl:w-[10rem] build canary, and OS-aware shortcut badge", () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", configurable: true });
    try {
      const { rerender } = render(<TopNav />);
      const searchBtn = btn("Search coin or page");
      expect(searchBtn.className).toContain("xl:w-[10rem]");
      expect(searchBtn.querySelector("kbd")?.textContent).toBe("Ctrl K");
      const visibleLabels = [...searchBtn.querySelectorAll("span")].map((s) => s.textContent);
      expect(visibleLabels).toEqual(["Search", "Coin or page"]);
      const accessibleName = searchBtn.getAttribute("aria-label")!.toLowerCase();
      for (const visible of visibleLabels) expect(accessibleName).toContain(visible!.toLowerCase());
      hydratedMock.current = true; rerender(<TopNav />);
      expect(btn("Search coin or page").querySelector("kbd")?.textContent).toBe("⌘K");
    } finally { Object.defineProperty(navigator, "userAgent", { value: originalUserAgent, configurable: true }); }
  });
});
