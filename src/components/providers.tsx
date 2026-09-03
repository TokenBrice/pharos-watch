"use client";

import { ThemeProvider } from "next-themes";
import { usePathname } from "next/navigation";
import { createContext, lazy, Suspense, useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Custom event broadcast when the user presses a numeric key (1-9) to sort
 * by the Nth visible column. Tables listen and call `toggleSort(visibleColumns[n-1])`.
 */
export const SORT_COLUMN_EVENT = "pharos-sort-column" as const;

export interface SortColumnEventDetail {
  columnNumber: number;
}

interface ToastContextType {
  addToast: (message: string, type?: "success" | "info" | "warning" | "error", duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

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

const InteractiveProviders = lazy(async () => {
  const [toastHook, themeHook, shortcutSettings, commandPalette, routeProgress] = await Promise.all([
    import("@/hooks/use-toast"),
    import("@/hooks/use-theme-toggle"),
    import("@/lib/keyboard-shortcut-settings"),
    import("@/lib/command-palette"),
    import("@/components/route-progress-bar"),
  ]);

  function LoadedInteractiveProviders({ children }: { children: React.ReactNode }) {
    const { toasts, addToast, removeToast } = toastHook.useToast();
    const { toggleTheme } = themeHook.useThemeToggle({ toast: addToast });
    const [commandPaletteLoaded, setCommandPaletteLoaded] = useState(false);
    const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
    const [keyboardShortcutsLoaded, setKeyboardShortcutsLoaded] = useState(false);
    const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);

    const openGlobalCommandPalette = useCallback(() => {
      setCommandPaletteLoaded(true);
      setCommandPaletteOpen(true);
    }, []);

    useEffect(() => {
      function handleOpenCommandPalette() {
        openGlobalCommandPalette();
      }

      function handleGlobalOverlayKeyDown(event: KeyboardEvent) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
          event.preventDefault();
          setCommandPaletteLoaded(true);
          setCommandPaletteOpen((open) => !open);
          return;
        }

        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement ||
          (event.target instanceof HTMLElement && event.target.isContentEditable)
        ) {
          return;
        }

        if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (shortcutSettings.isSidebarShortcutDisabled()) return;
          event.preventDefault();
          setKeyboardShortcutsLoaded(true);
          setKeyboardShortcutsOpen(true);
          return;
        }

        if (event.ctrlKey || event.metaKey || event.altKey) return;

        if (event.key >= "1" && event.key <= "9") {
          if (shortcutSettings.isSidebarShortcutDisabled()) return;
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
          case "/":
            event.preventDefault();
            openGlobalCommandPalette();
            break;
        }
      }

      window.addEventListener(commandPalette.OPEN_COMMAND_PALETTE_EVENT, handleOpenCommandPalette);
      window.addEventListener("keydown", handleGlobalOverlayKeyDown);
      return () => {
        window.removeEventListener(commandPalette.OPEN_COMMAND_PALETTE_EVENT, handleOpenCommandPalette);
        window.removeEventListener("keydown", handleGlobalOverlayKeyDown);
      };
    }, [openGlobalCommandPalette, toggleTheme]);

    return (
      <ToastContext.Provider value={{ addToast }}>
        <routeProgress.RouteProgressBar />
        {children}
        {commandPaletteLoaded && (
          <Suspense fallback={null}>
            <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
          </Suspense>
        )}
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
      </ToastContext.Provider>
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
 * content routes, so the provider cannot be route-gated. Overlays, shortcuts,
 * toasts, and the route progress bar load only on interactive routes.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: PHAROS_QUERY_DEFAULT_OPTIONS }));
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>
          <RouteProviders>{children}</RouteProviders>
        </Suspense>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
