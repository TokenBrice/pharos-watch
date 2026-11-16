// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  Providers,
  SORT_COLUMN_EVENT,
  type SortColumnEventDetail,
} from "@/components/providers";
import { setSingleKeyShortcutDisabled } from "@/lib/keyboard-shortcut-settings";
import { openCommandPalette } from "@/lib/command-palette";
import NotFound from "@/app/not-found";
import { SiteSession } from "@/components/site-session";
import * as sessionClient from "@/lib/site-session-client";
import * as featureFlags from "@/lib/feature-flags";
import { ApiFetchError, SiteSessionRequiredError } from "@/lib/api";

const setThemeMock = vi.hoisted(() => vi.fn());
const refetchQueries = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

vi.mock("@tanstack/react-query", () => ({
  QueryClient: class QueryClient {},
  useQueryClient: () => ({ refetchQueries }),
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="query-client-provider">{children}</div>
  ),
}));

vi.mock("@/components/keyboard-shortcuts", () => ({
  KeyboardShortcuts: ({ open }: { open: boolean }) =>
    open ? <div data-testid="keyboard-shortcuts-dialog" /> : null,
}));

vi.mock("@/components/command-palette/command-palette-root", () => ({
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
  refetchQueries.mockReset().mockResolvedValue(undefined);
  pathname = "/";
  window.localStorage.clear();
  document.getElementById("pharos-turnstile")?.remove();
  delete window.turnstile;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("SiteSession", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK", "true");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site-key");
  });

  it.each([0, 7200])("loads only when due (%s seconds left), renders immediately and recovers queries", async (remaining) => {
    if (remaining) localStorage.setItem("pharos-site-session-exp", String(Math.floor(Date.now() / 1000) + remaining));
    const mark = vi.fn();
    vi.stubGlobal("performance", { mark, now: Date.now });
    vi.spyOn(featureFlags, "isSiteSessionCheckEnabled").mockReturnValue(true);
    vi.spyOn(sessionClient, "renewSiteSessionIfNeeded").mockImplementation(() => {});
    let recover!: () => void;
    vi.spyOn(sessionClient, "registerSiteSessionRecovery").mockImplementation((callback) => {
      recover = callback;
      return () => {};
    });
    let run!: Parameters<typeof sessionClient.registerSiteSessionChallenge>[0];
    vi.spyOn(sessionClient, "registerSiteSessionChallenge").mockImplementation((challenge) => {
      run = challenge;
      return () => {};
    });
    const widget = { render: vi.fn().mockReturnValue("widget-id"), remove: vi.fn() };
    render(<SiteSession />);
    expect(!!document.getElementById("pharos-turnstile")).toBe(!remaining);
    expect(mark.mock.calls).toEqual(remaining ? [] : [["pharos-session-script"]]);
    const pending = run(new AbortController().signal);
    window.turnstile = widget;
    fireEvent.load(document.getElementById("pharos-turnstile")!);
    expect(widget.render).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      sitekey: "test-site-key", action: "site-data", appearance: "interaction-only", execution: "render",
      retry: "never", "refresh-expired": "never", "refresh-timeout": "never",
    }));
    widget.render.mock.calls[0]![1].callback("single-use-token");
    await expect(pending).resolves.toBe("single-use-token");
    expect(widget.remove).toHaveBeenCalledWith("widget-id");
    recover();
    const filter = refetchQueries.mock.calls[0]![0];
    expect(filter.type).toBe("active");
    for (const error of [new SiteSessionRequiredError("/api/test", 401, null), new ApiFetchError("/api/test", 401, null), null]) {
      expect(filter.predicate({ state: { error } })).toBe(error instanceof SiteSessionRequiredError);
    }
    const { QueryClient, QueryObserver } = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity, refetchOnMount: false } } });
    const reads = [0, 1, 2].map((i) => vi.fn().mockRejectedValueOnce(i === 1
      ? new ApiFetchError("/api/test", 401, null) : new SiteSessionRequiredError("/api/test", 401, null)).mockResolvedValue("recovered"));
    await Promise.allSettled(reads.map((queryFn, i) => client.fetchQuery({ queryKey: [i], queryFn })));
    const unsubscribe = reads.slice(0, 2).map((queryFn, i) => new QueryObserver(client, { queryKey: [i], queryFn }).subscribe(() => {}));
    refetchQueries.mockImplementation((filters) => client.refetchQueries(filters));
    recover();
    await vi.waitFor(() => expect(client.getQueryData([0])).toBe("recovered"));
    expect(reads.map((read) => read.mock.calls.length)).toEqual([2, 1, 1]);
    unsubscribe.forEach((stop) => stop());
    client.clear();
  });

  it("stays inert when disabled and shows one notice after rejection", () => {
    const enabled = vi.spyOn(featureFlags, "isSiteSessionCheckEnabled").mockReturnValue(false);
    vi.spyOn(sessionClient, "renewSiteSessionIfNeeded").mockImplementation(() => {});
    const paused = vi.spyOn(sessionClient, "isSiteSessionPaused").mockReturnValue(false);
    const { container, rerender } = render(<SiteSession />);
    expect(container.innerHTML).toBe("");
    expect(document.getElementById("pharos-turnstile")).toBeNull();
    enabled.mockReturnValue(true);
    rerender(<SiteSession />);
    expect(screen.queryByRole("status")).toBeNull();
    paused.mockReturnValue(true);
    rerender(<SiteSession />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Live data is paused: the browser check did not complete. Reload to try again.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.getElementById("pharos-turnstile")?.getAttribute("src")).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    rerender(<SiteSession />);
    expect(document.querySelectorAll("#pharos-turnstile")).toHaveLength(1);
  });
});

describe("Providers single-key shortcuts (WCAG 2.1.4 disable flag)", () => {

  it("lets the global shortcut toggle search once on the not-found page and keeps its search button", async () => {
    render(<Providers><NotFound /></Providers>);
    await screen.findByTestId("route-progress-bar");

    expect(pressKey("k", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(await screen.findByTestId("command-palette")).toBeTruthy();
    pressKey("k", { ctrlKey: true });
    expect(screen.queryByTestId("command-palette")).toBeNull();
    pressKey("k", { metaKey: true });
    expect(await screen.findByTestId("command-palette")).toBeTruthy();
    pressKey("k", { metaKey: true });
    expect(screen.queryByTestId("command-palette")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Search the dashboard/ }));
    expect(await screen.findByTestId("command-palette")).toBeTruthy();
  });

  it.each([
    "/about/",
    "/learn/mechanisms/",
    "/docs/dews/",
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

  it.each(["/docs/dews/", "/about/", "/stablecoin/usdt-tether/"])(
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

  it("keeps the shortcuts dialog reachable after single-key shortcuts are disabled", async () => {
    setSingleKeyShortcutDisabled(true);
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

});
