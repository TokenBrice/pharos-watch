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
  vi.clearAllMocks();
});

describe("MobileBottomNav", () => {
  it("renders four config-derived routes and the menu action as five equal items", () => {
    pathnameMock.mockReturnValue("/");
    render(<MobileBottomNav />);

    const nav = screen.getByRole("navigation", { name: "Mobile navigation" });
    const links = screen.getAllByRole("link");
    expect(nav.querySelector(".grid-cols-5")).toBeTruthy();
    expect(links).toHaveLength(routeItems.length);
    expect(screen.getAllByRole("button")).toHaveLength(1);

    routeItems.forEach((item, index) => {
      expect(links[index]?.getAttribute("href")).toBe(item.href);
      const expectedLabel = item.shortLabel ?? item.label;
      expect(links[index]?.textContent).toContain(expectedLabel);
    });
    expect(screen.getByRole("link", { name: "Depeg" }).getAttribute("href")).toBe("/depeg/");
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

  it("dispatches the drawer-open event from Menu and exposes its state", () => {
    pathnameMock.mockReturnValue("/");
    const handleOpen = vi.fn();
    window.addEventListener(OPEN_NAV_DRAWER_EVENT, handleOpen);

    render(<MobileBottomNav />);
    const menu = screen.getByRole("button", { name: "Menu" });
    expect([menu.getAttribute("aria-haspopup"), menu.getAttribute("aria-expanded")]).toEqual(["dialog", "false"]);
    fireEvent.click(menu);

    expect(handleOpen).toHaveBeenCalledOnce();
    act(() => setNavDrawerOpen(true));
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    act(() => setNavDrawerOpen(false));
    window.removeEventListener(OPEN_NAV_DRAWER_EVENT, handleOpen);
  });

});
