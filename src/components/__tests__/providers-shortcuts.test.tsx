// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  PHAROS_QUERY_DEFAULT_OPTIONS,
  Providers,
  SORT_COLUMN_EVENT,
  type SortColumnEventDetail,
} from "@/components/providers";
import { setSidebarShortcutDisabled } from "@/lib/keyboard-shortcut-settings";

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

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));

vi.mock("@/components/route-progress-bar", () => ({
  RouteProgressBar: () => <div data-testid="route-progress-bar" />,
}));

function pressKey(key: string) {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
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
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 0);
    await tick.promise;
    expect(screen.queryByTestId("route-progress-bar")).toBeNull();
  });

  it("mounts the interactive layer on data routes", async () => {
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

      await screen.findByTestId("query-client-provider");

      const event = pressKey("3");

      expect(onSort).toHaveBeenCalledTimes(1);
      const detail = (onSort.mock.calls[0][0] as CustomEvent<SortColumnEventDetail>).detail;
      expect(detail.columnNumber).toBe(3);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener(SORT_COLUMN_EVENT, onSort as EventListener);
    }
  });

  it("ignores numeric column sort when single-key shortcuts are disabled", async () => {
    setSidebarShortcutDisabled(true);
    const onSort = vi.fn();
    window.addEventListener(SORT_COLUMN_EVENT, onSort as EventListener);
    try {
      render(
        <Providers>
          <div />
        </Providers>,
      );

      await screen.findByTestId("query-client-provider");

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

    await screen.findByTestId("query-client-provider");

    const event = pressKey("?");

    expect(await screen.findByTestId("keyboard-shortcuts-dialog")).toBeTruthy();
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores ? when single-key shortcuts are disabled", async () => {
    setSidebarShortcutDisabled(true);
    render(
      <Providers>
        <div />
      </Providers>,
    );

    await screen.findByTestId("query-client-provider");

    const event = pressKey("?");

    expect(screen.queryByTestId("keyboard-shortcuts-dialog")).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});
