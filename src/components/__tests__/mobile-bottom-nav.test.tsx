// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { QUICK_NAV_ITEMS } from "@/lib/nav-config";
import { OPEN_NAV_DRAWER_EVENT } from "@/lib/nav-drawer";

const { pathnameMock } = vi.hoisted(() => ({ pathnameMock: vi.fn() }));

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

const routeItems = QUICK_NAV_ITEMS.filter((item) => item.href !== "/stability-index/");

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
      const expectedLabel = item.shortLabel === "DDR" ? "Depegs" : (item.shortLabel ?? item.label);
      expect(links[index]?.textContent).toContain(expectedLabel);
    });
  });

  it("marks the config-derived current route as the current page", () => {
    const activeItem = routeItems[1];
    pathnameMock.mockReturnValue(activeItem.href);
    render(<MobileBottomNav />);

    const activeLink = screen.getAllByRole("link").find((link) => link.getAttribute("href") === activeItem.href);
    expect(activeLink?.getAttribute("aria-current")).toBe("page");
  });

  it("dispatches the drawer-open event from Menu", () => {
    pathnameMock.mockReturnValue("/");
    const handleOpen = vi.fn();
    window.addEventListener(OPEN_NAV_DRAWER_EVENT, handleOpen);

    render(<MobileBottomNav />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));

    expect(handleOpen).toHaveBeenCalledOnce();
    window.removeEventListener(OPEN_NAV_DRAWER_EVENT, handleOpen);
  });
});
