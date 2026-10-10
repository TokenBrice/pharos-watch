// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PHAROS_QUERY_DEFAULT_OPTIONS,
  Providers,
  SORT_COLUMN_EVENT,
  type SortColumnEventDetail,
} from "@/components/providers";
import { setSingleKeyShortcutDisabled } from "@/lib/keyboard-shortcut-settings";
import { openCommandPalette } from "@/lib/command-palette";

const setThemeMock = vi.hoisted(() => vi.fn());

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

vi.mock("@tanstack/react-query", () => ({
  QueryClient: class QueryClient {},
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="query-client-provider">{children}</div>
  ),
}));

vi.mock("@/components/keyboard-shortcuts", () => ({
  KeyboardShortcuts: ({ open }: { open: boolean }) =>
    open ? <div data-testid="keyboard-shortcuts-dialog" /> : null,
}));

vi.mock("@/components/command-palette-root", () => ({
  CommandPalette: ({ open }: { open: boolean }) =>
    open ? <div data-testid="command-palette" /> : null,
}));

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: "light", setTheme: setThemeMock }),
}));

vi.mock("@/components/route-progress-bar", () => ({
  RouteProgressBar: () => <div data-testid="route-progress-bar" />,
}));

function pressKey(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...options });
  act(() => { target.dispatchEvent(event); });
  return event;
}

afterEach(() => {
  cleanup();
  setThemeMock.mockClear();
  pathname = "/";
  window.localStorage.clear();
});

describe("Providers single-key shortcuts (WCAG 2.1.4 disable flag)", () => {
  it("does not refetch cached queries on window focus by default", () => {
    expect(PHAROS_QUERY_DEFAULT_OPTIONS.queries.refetchOnWindowFocus).toBe(false);
  });

  it.each([
    "/about/",
    "/learn/mechanisms/",
    "/docs/api-reference/",
    "/changelog/",
    "/blog/client-runtime/",
    "/methodology/scoring-changelog/",
  ])("keeps the query client but omits the interactive layer on the static content route %s", async (staticPath) => {
    pathname = staticPath;
    render(
      <Providers>
        <div data-testid="static-child" />
      </Providers>,
    );

    expect(screen.getByTestId("static-child")).toBeTruthy();
    // Global chrome (TopNav health menu, RegimeBar PSI) queries on every route.
    expect(screen.getByTestId("query-client-provider")).toBeTruthy();
    // Give the lazy interactive layer a tick so an incorrect mount would surface.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("route-progress-bar")).toBeNull();
  });

  it.each(["/docs/api-reference/", "/about/", "/stablecoin/usdt-tether/"])(
    "opens global search by its real trigger and modified shortcut on %s without eager overlays",
    async (route) => {
      pathname = route;
      render(<Providers><button onClick={openCommandPalette}>Search</button></Providers>);
      expect(screen.queryByTestId("command-palette")).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "Search" }));
      expect(await screen.findByTestId("command-palette")).toBeTruthy();
      expect(pressKey("k", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(screen.queryByTestId("command-palette")).toBeNull();
      expect(pressKey("k", { metaKey: true }).defaultPrevented).toBe(true);
      expect(await screen.findByTestId("command-palette")).toBeTruthy();
      if (route.startsWith("/docs") || route.startsWith("/about")) {
        expect(screen.queryByTestId("route-progress-bar")).toBeNull();
      }
    },
  );

  it.each(["t", "/"])("honors the opt-out for %s while preserving modified search", async (key) => {
    render(<Providers><input aria-label="Editable" /></Providers>);
    await screen.findByTestId("route-progress-bar");
    expect(pressKey(key, {}, screen.getByRole("textbox")).defaultPrevented).toBe(false);
    expect(setThemeMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("command-palette")).toBeNull();

    setSingleKeyShortcutDisabled(true);
    expect(pressKey(key).defaultPrevented).toBe(false);
    expect(setThemeMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("command-palette")).toBeNull();
    expect(pressKey("k", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(await screen.findByTestId("command-palette")).toBeTruthy();
    pressKey("k", { ctrlKey: true });

    setSingleKeyShortcutDisabled(false);
    expect(pressKey(key).defaultPrevented).toBe(true);
    if (key === "t") expect(setThemeMock).toHaveBeenCalledTimes(1);
    else expect(await screen.findByTestId("command-palette")).toBeTruthy();
  });

  it("cold-loads the interactive layer on data routes", async () => {
    pathname = "/stablecoin/usdt-tether/";
    render(
      <Providers>
        <div data-testid="interactive-child" />
      </Providers>,
    );
    expect(await screen.findByTestId("route-progress-bar")).toBeTruthy();
    expect(screen.getByTestId("query-client-provider")).toBeTruthy();
  });

  it("broadcasts numeric column sort when single-key shortcuts are enabled", async () => {
    const onSort = vi.fn();
    window.addEventListener(SORT_COLUMN_EVENT, onSort as EventListener);
    try {
      render(
        <Providers>
          <div data-testid="interactive-child" />
        </Providers>,
      );

      await screen.findByTestId("route-progress-bar");

      const event = pressKey("3");

      expect(onSort).toHaveBeenCalledTimes(1);
      const detail = (onSort.mock.calls[0][0] as CustomEvent<SortColumnEventDetail>).detail;
      expect(detail.columnNumber).toBe(3);
      expect(event.defaultPrevented).toBe(true);

      setSingleKeyShortcutDisabled(true);
      onSort.mockClear();
      expect(pressKey("3").defaultPrevented).toBe(false);
      expect(onSort).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(SORT_COLUMN_EVENT, onSort as EventListener);
    }
  });

  it("ignores numeric column sort when single-key shortcuts are disabled", async () => {
    setSingleKeyShortcutDisabled(true);
    const onSort = vi.fn();
    window.addEventListener(SORT_COLUMN_EVENT, onSort as EventListener);
    try {
      render(
        <Providers>
          <div />
        </Providers>,
      );

      await screen.findByTestId("route-progress-bar");

      const event = pressKey("3");

      expect(onSort).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener(SORT_COLUMN_EVENT, onSort as EventListener);
    }
  });

  it("opens the shortcuts dialog on ? when single-key shortcuts are enabled", async () => {
    render(
      <Providers>
        <div />
      </Providers>,
    );

    await screen.findByTestId("route-progress-bar");

    const event = pressKey("?");

    expect(await screen.findByTestId("keyboard-shortcuts-dialog")).toBeTruthy();
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores ? when single-key shortcuts are disabled", async () => {
    setSingleKeyShortcutDisabled(true);
    render(
      <Providers>
        <div />
      </Providers>,
    );

    await screen.findByTestId("route-progress-bar");

    const event = pressKey("?");

    expect(screen.queryByTestId("keyboard-shortcuts-dialog")).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});
