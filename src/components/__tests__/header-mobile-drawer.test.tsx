// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Header } from "@/components/header";
import { NAV_GROUPS } from "@/lib/nav-config";

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

vi.mock("@/components/theme-controls", () => ({
  ThemeControls: () => <div>Theme controls</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/sheet", async () => {
  const { cloneElement } = await import("react");
  let open = false;
  let setOpen: (open: boolean) => void = () => {};

  return {
    Sheet: ({ children, open: nextOpen, onOpenChange }: { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) => {
      open = nextOpen;
      setOpen = onOpenChange;
      return <>{children}</>;
    },
    SheetTrigger: ({ children }: { children: ReactElement<{ onClick?: () => void }> }) =>
      cloneElement(children, {
        onClick: () => {
          children.props.onClick?.();
          setOpen(true);
        },
      }),
    SheetContent: ({ children }: { children: ReactNode }) => open ? <div data-testid="mobile-drawer">{children}</div> : null,
    SheetDescription: ({ children, ...props }: ComponentProps<"p">) => <p {...props}>{children}</p>,
    SheetTitle: ({ children, ...props }: ComponentProps<"h2">) => <h2 {...props}>{children}</h2>,
  };
});

vi.mock("@/hooks/use-start-here-nav-visibility", () => ({
  useStartHereNavVisibility: () => ({ isReady: true, shouldShow: true }),
}));

vi.mock("@/lib/command-palette", () => ({
  openCommandPalette: vi.fn(),
}));

const categories = NAV_GROUPS.flatMap((group) =>
  group.columns
    ? group.columns.map((column) => ({ label: column.label, items: column.items }))
    : [{ label: group.label, items: group.items }],
);

function categoryButton(label: string, itemCount: number) {
  return screen.getByRole("button", { name: `${label}, ${itemCount} pages` });
}

function openDrawer() {
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
}

describe("Header mobile drawer", () => {
  it("drills into config-derived categories, returns with focus, and resets after closing", () => {
    render(<Header />);
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
});
