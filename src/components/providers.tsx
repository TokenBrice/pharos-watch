"use client";

import { ThemeProvider } from "next-themes";
import { usePathname } from "next/navigation";
import { lazy, Suspense, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/command-palette";
import { isSingleKeyShortcutDisabled } from "@/lib/keyboard-shortcut-settings";
import { SourceNavigationProvider } from "@/components/back-to-source";

/**
 * Custom event broadcast when the user presses a numeric key (1-9) to sort
 * by the Nth visible column. Tables listen and call `toggleSort(visibleColumns[n-1])`.
 */
export const SORT_COLUMN_EVENT = "pharos-sort-column" as const;

export interface SortColumnEventDetail {
  columnNumber: number;
}

export const PHAROS_QUERY_DEFAULT_OPTIONS = {
  queries: {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 2,
    retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 30000),
  },
};

const STATIC_CONTENT_ROUTE_ROOTS = [
  "/about",
  "/learn",
  "/docs",
  "/changelog",
  "/blog",
  "/methodology",
] as const;

function isStaticContentPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return STATIC_CONTENT_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

const CommandPalette = lazy(() =>
  import("./command-palette-root").then((mod) => ({ default: mod.CommandPalette })),
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

  useEffect(() => {
    const openSearch = () => {
      setLoaded(true);
      setOpen(true);
    };
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setLoaded(true);
        setOpen((value) => !value);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || isSingleKeyShortcutDisabled()) return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      ) return;
      if (event.key === "/") {
        event.preventDefault();
        openSearch();
      }
    }
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, openSearch);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, openSearch);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <>
      {children}
      {loaded && (
        <Suspense fallback={null}>
          <CommandPalette open={open} onOpenChange={setOpen} />
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

  function LoadedInteractiveProviders({ children }: { children: React.ReactNode }) {
    const { toasts, addToast, removeToast } = toastHook.useToast();
    const { toggleTheme } = themeHook.useThemeToggle({ toast: addToast });
    const [keyboardShortcutsLoaded, setKeyboardShortcutsLoaded] = useState(false);
    const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);

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

        if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (shortcutSettings.isSingleKeyShortcutDisabled()) return;
          event.preventDefault();
          setKeyboardShortcutsLoaded(true);
          setKeyboardShortcutsOpen(true);
          return;
        }

        if (event.ctrlKey || event.metaKey || event.altKey || shortcutSettings.isSingleKeyShortcutDisabled()) return;

        if (event.key >= "1" && event.key <= "9") {
          if (shortcutSettings.isSingleKeyShortcutDisabled()) return;
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
        {children}
        {keyboardShortcutsLoaded && (
          <Suspense fallback={null}>
            <KeyboardShortcuts open={keyboardShortcutsOpen} onOpenChange={setKeyboardShortcutsOpen} />
          </Suspense>
        )}
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

function RouteProviders({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (isStaticContentPath(pathname)) return children;
  return <InteractiveProviders>{children}</InteractiveProviders>;
}

/**
 * Theme and the query client are the immutable shell: the global chrome
 * (TopNav health menu, RegimeBar PSI) queries on every route, including static
 * content routes, so the provider cannot be route-gated. Search listeners and
 * their lazy overlay host are global; other interactive features remain gated.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: PHAROS_QUERY_DEFAULT_OPTIONS }));
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <SourceNavigationProvider>
          <GlobalSearchProvider>
            <Suspense fallback={null}>
              <RouteProviders>{children}</RouteProviders>
            </Suspense>
          </GlobalSearchProvider>
        </SourceNavigationProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
