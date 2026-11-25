"use client";

import { ThemeProvider } from "next-themes";
import { usePathname } from "next/navigation";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/command-palette";
import { OPEN_KEYBOARD_SHORTCUTS_EVENT, dismissChromeOverlays, subscribeChromeDismiss } from "@/lib/chrome-popover";
import { isSingleKeyShortcutDisabled } from "@/lib/keyboard-shortcut-settings";
import { SourceNavigationProvider } from "@/components/back-to-source";
import { isEditorialPath } from "@/lib/editorial-routes";
import { discardDataBootstrap } from "@/lib/data-bootstrap";

/**
 * Custom event broadcast when the user presses a numeric key (1-9) to sort
 * by the Nth visible column. Tables listen and call `toggleSort(visibleColumns[n-1])`.
 */
export const SORT_COLUMN_EVENT = "pharos-sort-column" as const;

export interface SortColumnEventDetail {
  columnNumber: number;
}

const PHAROS_QUERY_DEFAULT_OPTIONS = {
  queries: {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 2,
    retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 30000),
  },
};


const SiteSession = process.env.NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK === "true"
  ? (() => {
    // Inline only the tiny script starter; the manager and notice UI stay split.
    const scriptModule = import(/* webpackMode: "eager" */ "@/lib/site-session-script");
    const sessionModule = import("./site-session");
    const SessionCheck = lazy(() => sessionModule.then((mod) => ({ default: mod.SiteSession })));
    return function SessionLoader() {
      useEffect(() => { void scriptModule.then((mod) => mod.preloadSiteSessionScript()); }, []);
      return <>
        {process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() && <link rel="preconnect" href="https://challenges.cloudflare.com" />}
        <Suspense fallback={null}><SessionCheck /></Suspense>
      </>;
    };
  })()
  : null;

const CommandPalette = lazy(() =>
  import("./command-palette/command-palette-root").then((mod) => ({ default: mod.CommandPalette })),
);

const KeyboardShortcuts = lazy(() =>
  import("./keyboard-shortcuts").then((mod) => ({ default: mod.KeyboardShortcuts })),
);

const ToastContainer = lazy(() =>
  import("./toast-container").then((mod) => ({ default: mod.ToastContainer })),
);

function GlobalSearchProvider({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [shortcutsLoaded, setShortcutsLoaded] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const setPaletteOpen = useCallback((next: boolean) => {
    openRef.current = next;
    if (next) {
      dismissChromeOverlays("command-palette");
      setShortcutsOpen(false);
    }
    setOpen(next);
  }, []);

  const setShortcutsDialogOpen = useCallback((next: boolean) => {
    if (next) {
      dismissChromeOverlays("keyboard-shortcuts");
      openRef.current = false;
      setOpen(false);
    }
    setShortcutsOpen(next);
  }, []);

  useEffect(() => {
    const openSearch = () => {
      setLoaded(true);
      setPaletteOpen(true);
    };
    const openShortcuts = () => {
      setShortcutsLoaded(true);
      setShortcutsDialogOpen(true);
    };
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setLoaded(true);
        setPaletteOpen(!openRef.current);
        return;
      }
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      ) return;

      // `?` opens the shortcuts dialog on every route (including static
      // editorial routes) and even when single-key shortcuts are off so the
      // opt-out toggle remains reachable anywhere (WCAG 2.1.4).
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        openShortcuts();
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey || isSingleKeyShortcutDisabled()) return;
      if (event.key === "/") {
        event.preventDefault();
        openSearch();
      }
    }
    const stopShortcuts = subscribeChromeDismiss("keyboard-shortcuts", () => setShortcutsOpen(false));
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, openSearch);
    window.addEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, openShortcuts);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      stopShortcuts();
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, openSearch);
      window.removeEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, openShortcuts);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [setPaletteOpen, setShortcutsDialogOpen]);

  return (
    <>
      {children}
      {loaded && (
        <Suspense fallback={null}>
          <CommandPalette open={open} onOpenChange={setPaletteOpen} />
        </Suspense>
      )}
      {shortcutsLoaded && (
        <Suspense fallback={null}>
          <KeyboardShortcuts open={shortcutsOpen} onOpenChange={setShortcutsDialogOpen} />
        </Suspense>
      )}
    </>
  );
}
const InteractiveProviders = lazy(async () => {
  const [toastHook, themeHook, shortcutSettings, routeProgress] = await Promise.all([
    import("@/hooks/use-toast"),
    import("@/hooks/use-theme-toggle"),
    import("@/lib/keyboard-shortcut-settings"),
    import("@/components/route-progress-bar"),
  ]);

  function LoadedInteractiveProviders() {
    const { toasts, addToast, removeToast } = toastHook.useToast();
    const { toggleTheme } = themeHook.useThemeToggle({ toast: addToast });

    useEffect(() => {
      function handleGlobalOverlayKeyDown(event: KeyboardEvent) {
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement ||
          (event.target instanceof HTMLElement && event.target.isContentEditable)
        ) {
          return;
        }

        if (event.ctrlKey || event.metaKey || event.altKey || shortcutSettings.isSingleKeyShortcutDisabled()) return;

        if (event.key >= "1" && event.key <= "9") {
          event.preventDefault();
          window.dispatchEvent(
            new CustomEvent<SortColumnEventDetail>(SORT_COLUMN_EVENT, {
              detail: { columnNumber: Number(event.key) },
            }),
          );
          return;
        }

        switch (event.key.toLowerCase()) {
          case "t":
            event.preventDefault();
            toggleTheme();
            break;
        }
      }

      window.addEventListener("keydown", handleGlobalOverlayKeyDown);
      return () => {
        window.removeEventListener("keydown", handleGlobalOverlayKeyDown);
      };
    }, [toggleTheme]);

    return (
      <>
        <routeProgress.RouteProgressBar />
        {toasts.length > 0 && (
          <Suspense fallback={null}>
            <ToastContainer toasts={toasts} removeToast={removeToast} />
          </Suspense>
        )}
      </>
    );
  }

  return { default: LoadedInteractiveProviders };
});

function RouteProviders() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname && window.__pharosDataBootstrap?.route !== pathname) discardDataBootstrap();
  }, [pathname]);
  if (isEditorialPath(pathname)) return null;
  return <InteractiveProviders />;
}

/**
 * Theme and the query client are the immutable shell: the global chrome
 * (TopNav incident badge, RegimeBar PSI) queries on every route, including
 * static content routes, so the provider cannot be route-gated. Search and
 * keyboard-shortcuts listeners and their lazy overlay hosts are global; other
 * interactive features remain gated.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: PHAROS_QUERY_DEFAULT_OPTIONS }));
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <SourceNavigationProvider>
          <GlobalSearchProvider>
            {SiteSession && process.env.NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK === "true" && (
              <Suspense fallback={null}>
                <SiteSession />
              </Suspense>
            )}
            {children}
            <Suspense fallback={null}>
              <RouteProviders />
            </Suspense>
          </GlobalSearchProvider>
        </SourceNavigationProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
