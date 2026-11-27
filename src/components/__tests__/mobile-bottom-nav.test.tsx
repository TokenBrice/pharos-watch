// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { QUICK_NAV_ITEMS } from "@/lib/nav-config";
import { OPEN_NAV_DRAWER_EVENT, setNavDrawerOpen } from "@/lib/nav-drawer";

const { pathnameMock, snapshotMock } = vi.hoisted(() => ({ pathnameMock: vi.fn(), snapshotMock: vi.fn(() => ({ data: undefined as unknown })) }));
vi.mock("@/hooks/api-hooks", () => ({ useHomepageSnapshot: snapshotMock }));
vi.mock("next/navigation", () => ({ usePathname: () => pathnameMock() }));
vi.mock("next/link", async () => {
  const { forwardRef } = await import("react");
  return { default: forwardRef<HTMLAnchorElement, ComponentProps<"a"> & { prefetch?: boolean }>(function MockLink({ prefetch: _p, ...props }, ref) { return <a ref={ref} {...props} />; }) };
});
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
const routeItems = QUICK_NAV_ITEMS.filter((i) => !["/stability-index/", "/freezewatch/"].includes(i.href));
afterEach(() => { act(() => setNavDrawerOpen(false)); vi.clearAllMocks(); });

describe("MobileBottomNav", () => {
  it("renders four config-derived routes and Menu as five centered columns with a non-color active indicator", () => {
    pathnameMock.mockReturnValue("/");
    render(<MobileBottomNav />);
    const grid = screen.getByRole("navigation", { name: "Mobile navigation" }).querySelector(".grid-cols-5") as HTMLElement | null;
    expect(grid).toBeTruthy(); expect(grid?.className).toContain("mx-auto"); expect(grid?.className).toContain("max-w-xl");
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(routeItems.length); expect(screen.getAllByRole("button")).toHaveLength(1);
    routeItems.forEach((item, i) => {
      expect(links[i]?.getAttribute("href")).toBe(item.href);
      expect(links[i]?.textContent).toContain(item.shortLabel ?? item.label);
    });
    const home = screen.getByRole("link", { name: "Home" });
    expect(home.getAttribute("aria-current")).toBe("page"); expect(home.className).toContain("text-brand-accent-text");
    expect(home.querySelector(".bg-brand-accent-text.h-0\\.5")).toBeTruthy(); expect(home.querySelector("span.font-semibold")?.textContent).toBe("Home");
    const depeg = screen.getByRole("link", { name: "Depeg" });
    expect(depeg.getAttribute("href")).toBe("/depeg/"); expect(depeg.getAttribute("aria-current")).toBeNull();
    expect(depeg.querySelector(".bg-brand-accent-text")).toBeNull(); expect(depeg.querySelector("span.font-medium")?.textContent).toBe("Depeg");
  });

  it("badges Depeg with the open-incident count and names it for assistive tech", () => {
    pathnameMock.mockReturnValue("/");
    snapshotMock.mockReturnValue({ data: { incidents: { data: { activeDepegCount: 1, recentActiveDepegCount: 1, longRunningActiveDepegCount: 0 } } } });
    const v = render(<MobileBottomNav />);
    const depeg = screen.getByRole("link", { name: /^Depeg/ });
    expect(depeg.textContent).toContain(", 1 recent depeg");
    expect(depeg.querySelector('[aria-hidden="true"].rounded-full')?.textContent).toBe("1");
    for (const [data, pill, sr] of [
      [{ activeDepegCount: 5, recentActiveDepegCount: 2, longRunningActiveDepegCount: 3 }, "2", ", 2 recent depegs, 3 long-running"],
      [{ activeDepegCount: 4, recentActiveDepegCount: 0, longRunningActiveDepegCount: 4 }, null, ", 0 recent, 4 long-running active depegs"],
      [{ activeDepegCount: 3 }, null, null],
    ] as const) {
      snapshotMock.mockReturnValue({ data: { incidents: { data } } }); v.rerender(<MobileBottomNav />);
      expect([depeg.querySelector('[aria-hidden="true"].rounded-full')?.textContent ?? null, depeg.querySelector(".sr-only")?.textContent ?? null]).toEqual([pill, sr]);
    }
    snapshotMock.mockReturnValue({ data: undefined });
  });

  it("marks Menu active when the drawer is open or when on a drawer-only route", () => {
    pathnameMock.mockReturnValue("/");
    const handleOpen = vi.fn(); window.addEventListener(OPEN_NAV_DRAWER_EVENT, handleOpen);
    const { rerender } = render(<MobileBottomNav />);
    const menu = screen.getByRole("button", { name: "Menu" });
    expect([menu.getAttribute("aria-haspopup"), menu.getAttribute("aria-expanded")]).toEqual(["dialog", "false"]);
    expect(menu.className).toContain("cursor-pointer"); expect(menu.className).not.toContain("text-brand-accent-text");
    expect(menu.querySelector(".bg-brand-accent-text")).toBeNull();
    fireEvent.click(menu); expect(handleOpen).toHaveBeenCalledOnce();
    act(() => setNavDrawerOpen(true));
    expect(menu.getAttribute("aria-expanded")).toBe("true"); expect(menu.className).toContain("text-brand-accent-text");
    expect(menu.querySelector(".bg-brand-accent-text.h-0\\.5")).toBeTruthy(); expect(menu.querySelector("span.font-semibold")?.textContent).toBe("Menu");
    act(() => setNavDrawerOpen(false)); expect(menu.className).not.toContain("text-brand-accent-text");
    pathnameMock.mockReturnValue("/about/"); rerender(<MobileBottomNav />);
    expect(menu.getAttribute("aria-expanded")).toBe("false"); expect(menu.className).toContain("text-brand-accent-text");
    expect(menu.querySelector(".bg-brand-accent-text.h-0\\.5")).toBeTruthy(); expect(menu.querySelector("span.font-semibold")?.textContent).toBe("Menu");
    for (const link of screen.getAllByRole("link")) expect(link.getAttribute("aria-current")).toBeNull();
    window.removeEventListener(OPEN_NAV_DRAWER_EVENT, handleOpen);
  });
});
