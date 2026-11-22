// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Header } from "@/components/header";
import { NAV_GROUPS } from "@/lib/nav-config";
import { openCommandPalette } from "@/lib/command-palette";
import { openNavDrawer } from "@/lib/nav-drawer";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
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

vi.mock("@/components/pharos-logo", () => ({
  PharosLogo: () => <span aria-hidden="true">Logo</span>,
}));

vi.mock("@/components/psi-beacon/regime-bar", () => ({
  RegimeBarToggle: () => null,
}));

vi.mock("@/components/theme-controls", () => ({
  ThemeControls: () => <div>Theme controls</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));

const { sheetCloseEvents } = vi.hoisted(() => ({
  sheetCloseEvents: [] as Array<{ defaultPrevented: boolean }>,
}));

vi.mock("@/components/ui/sheet", async () => {
  const { cloneElement, useEffect, useRef } = await import("react");
  let open = false;
  let setOpen: (open: boolean) => void = () => {};
  let latestCloseAutoFocus: ((event: Event) => void) | undefined;

  return {
    Sheet: ({ children, open: nextOpen, onOpenChange }: { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) => {
      const wasOpenRef = useRef(false);
      open = nextOpen;
      setOpen = onOpenChange;
      useEffect(() => {
        if (wasOpenRef.current && !nextOpen && latestCloseAutoFocus) {
          const event = new Event("focus", { cancelable: true });
          latestCloseAutoFocus(event);
          sheetCloseEvents.push({ defaultPrevented: event.defaultPrevented });
        }
        wasOpenRef.current = nextOpen;
      }, [nextOpen]);
      return <>{children}</>;
    },
    SheetTrigger: ({ children }: { children: ReactElement<{ onClick?: () => void }> }) =>
      cloneElement(children, {
        onClick: () => {
          children.props.onClick?.();
          setOpen(true);
        },
      }),
    SheetContent: ({ children, onCloseAutoFocus }: { children: ReactNode; onCloseAutoFocus?: (event: Event) => void }) => {
      latestCloseAutoFocus = onCloseAutoFocus;
      return open ? <div data-testid="mobile-drawer">{children}</div> : null;
    },
    SheetDescription: ({ children, ...props }: ComponentProps<"p">) => <p {...props}>{children}</p>,
    SheetTitle: ({ children, ...props }: ComponentProps<"h2">) => <h2 {...props}>{children}</h2>,
  };
});

vi.mock("@/lib/command-palette", () => ({
  openCommandPalette: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

// The drawer mirrors the desktop menus one-to-one; sections become subheads.
const categories = NAV_GROUPS.map((group) => ({
  label: group.label,
  items: group.sections ? group.sections.flatMap((section) => section.items) : group.items,
}));

function categoryButton(label: string, itemCount: number) {
  return screen.getByRole("button", { name: `${label}, ${itemCount} pages` });
}

// The bottom-nav Menu is the only opener; the header carries no duplicate.
function openDrawer() {
  act(() => openNavDrawer());
}

describe("Header mobile drawer", () => {
  afterEach(() => {
    sheetCloseEvents.length = 0;
    vi.clearAllMocks();
  });

  it("drills into config-derived categories, returns with focus, and resets after closing", () => {
    render(<Header />);
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    openDrawer();

    for (const category of categories) {
      expect(categoryButton(category.label, category.items.length)).toBeTruthy();
    }

    const selectedCategory = categories[0];
    const selectedCategoryButton = categoryButton(selectedCategory.label, selectedCategory.items.length);
    fireEvent.click(selectedCategoryButton);

    const categoryHeading = screen.getByRole("heading", { name: selectedCategory.label, level: 2 });
    expect(document.activeElement).toBe(categoryHeading);
    expect(screen.getByRole("button", { name: "Back to menu" })).toBeTruthy();
    for (const item of selectedCategory.items) {
      expect(
        screen.getAllByRole("link").some((link) => link.getAttribute("href") === item.href),
      ).toBe(true);
    }

    fireEvent.click(screen.getByRole("button", { name: "Back to menu" }));
    expect(document.activeElement).toBe(categoryButton(selectedCategory.label, selectedCategory.items.length));
    expect(screen.queryByRole("button", { name: "Back to menu" })).toBeNull();

    fireEvent.click(categoryButton(selectedCategory.label, selectedCategory.items.length));
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByTestId("mobile-drawer")).toBeNull();

    openDrawer();
    expect(screen.queryByRole("button", { name: "Back to menu" })).toBeNull();
    for (const category of categories) {
      expect(categoryButton(category.label, category.items.length)).toBeTruthy();
    }
  });

  it("shows non-bottom-nav tools in the quick grid without left-alignment skew", () => {
    render(<Header />);
    openDrawer();

    const drawer = screen.getByTestId("mobile-drawer");
    expect(drawer.innerHTML).not.toContain("pl-[14px]");

    const quickGrid = drawer.querySelector(".grid.grid-cols-2");
    expect(quickGrid).not.toBeNull();
    const quickLabels = [...quickGrid!.querySelectorAll("a")].map((link) => link.textContent?.trim());
    expect(quickLabels).toEqual([
      "Stability",
      "FreezeWatch",
      "Screener",
      "Compare",
      "Portfolio",
      "Alert Bot",
    ]);
  });

  it("uses exact h-14 border-box height on header and clears opener focus on drawer Search and navigation", () => {
    render(
      <>
        <button type="button" data-testid="bottom-menu-opener">Menu</button>
        <input data-testid="palette-input" />
        <Header />
      </>,
    );

    const header = document.querySelector("header")!;
    expect(header.className).toContain("h-14");

    const opener = screen.getByTestId("bottom-menu-opener");
    const paletteInput = screen.getByTestId("palette-input");

    // Closing via Close menu restores focus to the opener.
    opener.focus();
    openDrawer();
    paletteInput.focus();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(document.activeElement).toBe(opener);

    // Opening Search from the drawer must NOT steal focus back to the opener on close.
    opener.focus();
    openDrawer();
    const drawer = screen.getByTestId("mobile-drawer");
    const drawerSearchBtn = [...drawer.querySelectorAll("button")].find((btn) => btn.textContent?.trim() === "Search")!;
    paletteInput.focus();
    fireEvent.click(drawerSearchBtn);
    expect(openCommandPalette).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(paletteInput);
    expect(sheetCloseEvents.at(-1)?.defaultPrevented).toBe(true);

    // Navigating via a drawer link must NOT restore focus back to the opener on close.
    opener.focus();
    openDrawer();
    const quickLink = screen.getByTestId("mobile-drawer").querySelector<HTMLAnchorElement>("a[href]")!;
    paletteInput.focus();
    fireEvent.click(quickLink);
    expect(document.activeElement).toBe(paletteInput);
    expect(sheetCloseEvents.at(-1)?.defaultPrevented).toBe(true);
  });

});
