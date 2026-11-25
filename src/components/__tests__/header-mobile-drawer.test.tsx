// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Header } from "@/components/header";
import { MOBILE_DRAWER_QUICK_ITEMS, NAV_GROUPS } from "@/lib/nav-config";
import { trackEvent } from "@/lib/analytics";
import { CHROME_DISMISS_EVENT, dismissChromeOverlays } from "@/lib/chrome-popover";
import { openCommandPalette } from "@/lib/command-palette";
import { openNavDrawer } from "@/lib/nav-drawer";

const { pathnameMock, sheetCloseEvents } = vi.hoisted(() => ({
  pathnameMock: vi.fn(() => "/"),
  sheetCloseEvents: [] as Array<{ defaultPrevented: boolean }>,
}));

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

vi.mock("@/components/pharos-logo", () => ({
  PharosLogo: ({ size }: { size?: number }) => <span data-testid="pharos-logo" data-size={size} aria-hidden="true" />,
}));

vi.mock("@/components/psi-beacon/regime-bar", () => ({
  RegimeBarToggle: ({ className }: { className?: string }) => (
    <div data-testid="regime-bar-toggle" className={className} />
  ),
}));

vi.mock("@/components/theme-controls", () => ({
  ThemeControls: ({ density }: { density: string }) => <div data-testid="theme-controls" data-density={density} />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
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
    SheetContent: ({
      children,
      className,
      onCloseAutoFocus,
    }: {
      children: ReactNode;
      className?: string;
      onCloseAutoFocus?: (event: Event) => void;
    }) => {
      latestCloseAutoFocus = onCloseAutoFocus;
      return open ? (
        <div data-testid="mobile-drawer" className={className}>
          {children}
        </div>
      ) : null;
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

// The bottom-nav Menu is the only opener; the header carries no duplicate.
function openDrawer() {
  act(() => openNavDrawer());
}

function categoryButton(label: string, itemCount: number) {
  return screen.getByRole("button", { name: `${label} ${itemCount}` });
}

describe("Header mobile drawer", () => {
  afterEach(() => {
    pathnameMock.mockReturnValue("/");
    sheetCloseEvents.length = 0;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps single opener invariant, flush w-full header alignment, min-h-11 controls, and sm:max-w-md drawer", () => {
    render(<Header />);

    const header = screen.getByRole("banner", { name: "Primary" });
    expect(header.className).toContain("h-14");
    expect(header.className).toContain("border-border/70");

    const innerWrapper = header.firstElementChild as HTMLElement;
    expect(innerWrapper.className).toContain("w-full");
    expect(innerWrapper.className).not.toContain("container");

    // Bottom-nav Menu is the sole drawer opener.
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();

    const brandLink = screen.getByRole("link", { name: "Pharos" });
    expect(brandLink.getAttribute("aria-current")).toBe("page");
    expect(brandLink.className).toContain("min-h-11");

    expect(screen.getByTestId("regime-bar-toggle").className).toContain("min-h-11");

    const searchBtn = screen.getByRole("button", { name: "Search stablecoins and pages" });
    expect(searchBtn.className).toContain("min-h-11");
    expect(searchBtn.textContent?.trim()).toBe("Search");
    fireEvent.click(searchBtn);
    expect(openCommandPalette).toHaveBeenCalledTimes(1);

    openDrawer();
    const drawer = screen.getByTestId("mobile-drawer");
    expect(drawer.className).toContain("sm:max-w-md");
    expect(drawer.className).not.toContain("sm:max-w-full");
  });

  it("renders the two pinned monitors with descriptions and zero Tools duplication", () => {
    pathnameMock.mockReturnValue("/freezewatch/");
    render(<Header />);
    openDrawer();

    const drawer = screen.getByTestId("mobile-drawer");
    const quickGrid = drawer.querySelector(".grid.grid-cols-2");
    expect(quickGrid).not.toBeNull();

    const quickLinks = [...quickGrid!.querySelectorAll("a")];
    expect(quickLinks).toHaveLength(MOBILE_DRAWER_QUICK_ITEMS.length);
    expect(quickLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/stability-index/",
      "/freezewatch/",
    ]);
    expect(quickLinks[0]?.textContent).toContain("Stability");
    expect(quickLinks[0]?.textContent).toContain("Market-regime read for stablecoins");
    expect(quickLinks[1]?.textContent).toContain("FreezeWatch");
    expect(quickLinks[1]?.textContent).toContain("Issuer power to freeze your balance");
    expect(quickLinks[1]?.getAttribute("aria-current")).toBe("page");
    expect(quickLinks[1]?.innerHTML).toContain("text-brand-accent-text");

    // Tools items must not be duplicated in the pinned grid.
    for (const toolLabel of ["Screener", "Compare", "Portfolio", "Alert Bot"]) {
      expect(quickGrid!.textContent).not.toContain(toolLabel);
    }
  });

  it("renders all five NAV_GROUPS as collapsible accordions with list semantics, Pharos sections, and no footer Search", () => {
    pathnameMock.mockReturnValue("/status/");
    render(<Header />);
    openDrawer();

    const drawer = screen.getByTestId("mobile-drawer");
    expect(screen.queryByRole("button", { name: "Back to menu" })).toBeNull();

    // Every category header renders with high-contrast count badge and aria-expanded.
    for (const group of NAV_GROUPS) {
      const btn = categoryButton(group.label, group.items.length);
      expect(btn.getAttribute("aria-controls")).toBe(`mobile-nav-${group.key}-panel`);
      expect(btn.innerHTML).not.toContain("text-muted-foreground/70");
    }

    const pharosGroup = NAV_GROUPS.find((group) => group.key === "pharos")!;
    const marketsGroup = NAV_GROUPS.find((group) => group.key === "markets")!;
    const riskGroup = NAV_GROUPS.find((group) => group.key === "risk")!;

    // Active route (/status/) expands Pharos automatically and marks it aria-current="true".
    const pharosBtn = categoryButton(pharosGroup.label, pharosGroup.items.length);
    expect(pharosBtn.getAttribute("aria-expanded")).toBe("true");
    expect(pharosBtn.getAttribute("aria-current")).toBe("true");
    expect(categoryButton(marketsGroup.label, marketsGroup.items.length).getAttribute("aria-expanded")).toBe("false");

    const pharosPanel = document.getElementById("mobile-nav-pharos-panel")!;
    expect(pharosPanel).toBeTruthy();

    // Trust & operations subhead links to its <ul> via aria-labelledby.
    const trustHeading = within(pharosPanel).getByText("Trust & operations");
    expect(trustHeading.className).toContain("pharos-label");
    const trustList = pharosPanel.querySelector(`ul[aria-labelledby="${trustHeading.id}"]`);
    expect(trustList).not.toBeNull();
    expect(within(trustList as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
    const statusLink = within(trustList as HTMLElement).getByRole("link", { name: /Status/ });
    expect(statusLink.getAttribute("aria-current")).toBe("page");

    // PharosVille external link preserves its description in the accessible name (no aria-label overwrite).
    const pharosVilleLink = within(pharosPanel).getByRole("link", { name: /PharosVille/ });
    expect(pharosVilleLink.getAttribute("href")).toBe("https://pharosville.pharos.watch/");
    expect(pharosVilleLink.getAttribute("target")).toBe("_blank");
    expect(pharosVilleLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(pharosVilleLink.hasAttribute("aria-label")).toBe(false);
    expect(pharosVilleLink.textContent).toContain("(opens in new tab)");
    expect(pharosVilleLink.textContent).toContain("Explore the stablecoin universe as a live harbor");

    // Expanding Risk works in one tap alongside Pharos and exposes quick-bar cross-references.
    const riskBtn = categoryButton(riskGroup.label, riskGroup.items.length);
    fireEvent.click(riskBtn);
    expect(riskBtn.getAttribute("aria-expanded")).toBe("true");
    expect(pharosBtn.getAttribute("aria-expanded")).toBe("true");
    const riskPanel = document.getElementById("mobile-nav-risk-panel")!;
    expect(within(riskPanel).getByText("On the quick bar")).toBeTruthy();
    expect(within(riskPanel).getByRole("link", { name: "Safety Scores" }).getAttribute("href")).toBe("/safety-scores/");
    expect(within(riskPanel).getByRole("link", { name: "Depeg & Recovery" }).getAttribute("href")).toBe("/depeg/");
    expect(within(riskPanel).getByRole("link", { name: "FreezeWatch" }).getAttribute("href")).toBe("/freezewatch/");

    // Drawer footer carries Appearance + ThemeControls, with no redundant Search button.
    expect(within(drawer).getByText("Appearance")).toBeTruthy();
    expect(within(drawer).getByTestId("theme-controls").getAttribute("data-density")).toBe("mobile");
    const drawerSearchButtons = [...drawer.querySelectorAll("button")].filter((btn) =>
      btn.textContent?.trim().includes("Search"),
    );
    expect(drawerSearchButtons).toHaveLength(0);

    // Internal drawer clicks report group.key (matching TopNav); external links do not report.
    fireEvent.click(statusLink);
    expect(trackEvent).toHaveBeenCalledWith("nav_click", {
      surface: "drawer",
      group: "pharos",
      href: "/status/",
    });

    vi.clearAllMocks();
    openDrawer();
    const reopenedPharosVille = screen.getByRole("link", { name: /PharosVille/ });
    reopenedPharosVille.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(reopenedPharosVille);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("restores opener focus on Close, suppresses focus restoration on navigation, and auto-closes on overlay, route, and desktop breakpoint changes", () => {
    const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(min-width: 1024px)",
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          mediaListeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          mediaListeners.delete(listener);
        },
      })),
    );

    const dismissSpy = vi.fn();
    window.addEventListener(CHROME_DISMISS_EVENT, dismissSpy);

    const { rerender } = render(
      <>
        <button type="button" data-testid="bottom-menu-opener">
          Menu
        </button>
        <input data-testid="palette-input" />
        <Header />
      </>,
    );

    const opener = screen.getByTestId("bottom-menu-opener");
    const paletteInput = screen.getByTestId("palette-input");

    // Closing via Close menu restores focus to the opener; opening dismisses sibling chrome overlays.
    opener.focus();
    openDrawer();
    expect(dismissSpy).toHaveBeenCalledTimes(1);
    expect((dismissSpy.mock.calls[0]?.[0] as CustomEvent<{ source: string }>).detail.source).toBe("nav-drawer");

    paletteInput.focus();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByTestId("mobile-drawer")).toBeNull();
    expect(document.activeElement).toBe(opener);

    // Navigating via a drawer link must NOT restore focus back to the opener on close.
    opener.focus();
    openDrawer();
    const quickLink = screen.getByTestId("mobile-drawer").querySelector<HTMLAnchorElement>("a[href]")!;
    paletteInput.focus();
    fireEvent.click(quickLink);
    expect(screen.queryByTestId("mobile-drawer")).toBeNull();
    expect(document.activeElement).toBe(paletteInput);
    expect(sheetCloseEvents.at(-1)?.defaultPrevented).toBe(true);

    // Chrome overlay dismissal closes the drawer without stealing focus back to opener.
    opener.focus();
    openDrawer();
    paletteInput.focus();
    act(() => dismissChromeOverlays("command-palette"));
    expect(screen.queryByTestId("mobile-drawer")).toBeNull();
    expect(document.activeElement).toBe(paletteInput);

    // Route change closes an open drawer automatically without stealing focus.
    opener.focus();
    openDrawer();
    paletteInput.focus();
    pathnameMock.mockReturnValue("/chains/");
    rerender(
      <>
        <button type="button" data-testid="bottom-menu-opener">
          Menu
        </button>
        <input data-testid="palette-input" />
        <Header />
      </>,
    );
    expect(screen.queryByTestId("mobile-drawer")).toBeNull();
    expect(document.activeElement).toBe(paletteInput);

    // Crossing the desktop >=1024px breakpoint closes the drawer automatically.
    opener.focus();
    openDrawer();
    expect(screen.getByTestId("mobile-drawer")).toBeTruthy();
    act(() => {
      for (const listener of mediaListeners) {
        listener({ matches: true } as MediaQueryListEvent);
      }
    });
    expect(screen.queryByTestId("mobile-drawer")).toBeNull();

    window.removeEventListener(CHROME_DISMISS_EVENT, dismissSpy);
  });
});
