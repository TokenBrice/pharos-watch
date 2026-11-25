// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { QUICK_NAV_ITEMS } from "@/lib/nav-config";
import { OPEN_NAV_DRAWER_EVENT, setNavDrawerOpen } from "@/lib/nav-drawer";

const { pathnameMock, snapshotMock } = vi.hoisted(() => ({
  pathnameMock: vi.fn(),
  snapshotMock: vi.fn(() => ({ data: undefined as unknown })),
}));

vi.mock("@/hooks/api-hooks", () => ({ useHomepageSnapshot: snapshotMock }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}));

vi.mock("next/link", async () => {
  const { forwardRef } = await import("react");
  return {
    default: forwardRef<HTMLAnchorElement, ComponentProps<"a"> & { prefetch?: boolean }>(
      function MockLink({ prefetch: _prefetch, ...props }, ref) {
        return <a ref={ref} {...props} />;
      },
    ),
  };
});

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

// The bar keeps four route slots; Stability and FreezeWatch live in the drawer.
const routeItems = QUICK_NAV_ITEMS.filter((item) => !["/stability-index/", "/freezewatch/"].includes(item.href));

afterEach(() => {
  act(() => setNavDrawerOpen(false));
  vi.clearAllMocks();
});

describe("MobileBottomNav", () => {
  it("renders four config-derived routes and Menu as five centered columns with a non-color active indicator", () => {
    pathnameMock.mockReturnValue("/");
    render(<MobileBottomNav />);

    const nav = screen.getByRole("navigation", { name: "Mobile navigation" });
    const grid = nav.querySelector(".grid-cols-5") as HTMLElement | null;
    expect(grid).toBeTruthy();
    expect(grid?.className).toContain("mx-auto");
    expect(grid?.className).toContain("max-w-xl");

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(routeItems.length);
    expect(screen.getAllByRole("button")).toHaveLength(1);

    routeItems.forEach((item, index) => {
      expect(links[index]?.getAttribute("href")).toBe(item.href);
      const expectedLabel = item.shortLabel ?? item.label;
      expect(links[index]?.textContent).toContain(expectedLabel);
    });

    // Active tab pairs accent color with bold label weight and a top indicator bar.
    const homeLink = screen.getByRole("link", { name: "Home" });
    expect(homeLink.getAttribute("aria-current")).toBe("page");
    expect(homeLink.className).toContain("text-brand-accent-text");
    expect(homeLink.querySelector(".bg-brand-accent-text.h-0\\.5")).toBeTruthy();
    expect(homeLink.querySelector("span.font-semibold")?.textContent).toBe("Home");

    const depegLink = screen.getByRole("link", { name: "Depeg" });
    expect(depegLink.getAttribute("href")).toBe("/depeg/");
    expect(depegLink.getAttribute("aria-current")).toBeNull();
    expect(depegLink.querySelector(".bg-brand-accent-text")).toBeNull();
    expect(depegLink.querySelector("span.font-medium")?.textContent).toBe("Depeg");
  });

  it("badges Depeg with the open-incident count and names it for assistive tech", () => {
    pathnameMock.mockReturnValue("/");
    snapshotMock.mockReturnValue({ data: { incidents: { data: { activeDepegCount: 1 } } } });
    render(<MobileBottomNav />);
    const depeg = screen.getByRole("link", { name: /^Depeg/ });
    expect(depeg.textContent).toContain(", 1 active depeg");
    expect(depeg.querySelector('[aria-hidden="true"].rounded-full')?.textContent).toBe("1");
    snapshotMock.mockReturnValue({ data: undefined });
  });

  it("marks Menu active when the drawer is open or when on a drawer-only route", () => {
    pathnameMock.mockReturnValue("/");
    const handleOpen = vi.fn();
    window.addEventListener(OPEN_NAV_DRAWER_EVENT, handleOpen);

    const { rerender } = render(<MobileBottomNav />);
    const menu = screen.getByRole("button", { name: "Menu" });
    expect([menu.getAttribute("aria-haspopup"), menu.getAttribute("aria-expanded")]).toEqual(["dialog", "false"]);
    expect(menu.className).toContain("cursor-pointer");
    expect(menu.className).not.toContain("text-brand-accent-text");
    expect(menu.querySelector(".bg-brand-accent-text")).toBeNull();

    fireEvent.click(menu);
    expect(handleOpen).toHaveBeenCalledOnce();

    act(() => setNavDrawerOpen(true));
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(menu.className).toContain("text-brand-accent-text");
    expect(menu.querySelector(".bg-brand-accent-text.h-0\\.5")).toBeTruthy();
    expect(menu.querySelector("span.font-semibold")?.textContent).toBe("Menu");

    act(() => setNavDrawerOpen(false));
    expect(menu.className).not.toContain("text-brand-accent-text");

    // On a drawer-only route like /about/, Menu stays highlighted even while closed.
    pathnameMock.mockReturnValue("/about/");
    rerender(<MobileBottomNav />);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(menu.className).toContain("text-brand-accent-text");
    expect(menu.querySelector(".bg-brand-accent-text.h-0\\.5")).toBeTruthy();
    expect(menu.querySelector("span.font-semibold")?.textContent).toBe("Menu");
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("aria-current")).toBeNull();
    }

    window.removeEventListener(OPEN_NAV_DRAWER_EVENT, handleOpen);
  });
});
