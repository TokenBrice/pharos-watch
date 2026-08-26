"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { ThemeProvider } from "next-themes";
import { useState, useCallback, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/command-palette";
import { isSidebarShortcutDisabled } from "@/lib/keyboard-shortcut-settings";
import { RouteProgressBar } from "@/components/route-progress-bar";

// Create a context for toast functionality
import { createContext } from "react";

/**
 * Custom event broadcast when the user presses a numeric key (1-9) to sort
 * by the Nth visible column. Tables listen and call `toggleSort(visibleColumns[n-1])`.
 */
export const SORT_COLUMN_EVENT = "pharos-sort-column" as const;

export interface SortColumnEventDetail {
  columnNumber: number;
}

const CommandPalette = dynamic(() => import("./command-palette-root").then((mod) => mod.CommandPalette), {
  ssr: false,
});

const KeyboardShortcuts = dynamic(() => import("./keyboard-shortcuts").then((mod) => mod.KeyboardShortcuts), {
  ssr: false,
});

const ToastContainer = dynamic(() => import("./toast-container").then((mod) => mod.ToastContainer), {
  ssr: false,
});

interface ToastContextType {
  addToast: (message: string, type?: "success" | "info" | "warning" | "error", duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function createPharosQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 2,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
      },
    },
  });
}

// Inner component that has access to theme
function AppProviders({ children }: { children: React.ReactNode }) {
  const { toasts, addToast, removeToast } = useToast();
  const { toggleTheme } = useThemeToggle({ toast: addToast });
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

      if (
        event.key === "?" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        // WCAG 2.1.4: single-character shortcut, read the disable flag at
        // keypress time so the shortcuts dialog preference applies immediately.
        if (isSidebarShortcutDisabled()) return;
        event.preventDefault();
        setKeyboardShortcutsLoaded(true);
        setKeyboardShortcutsOpen(true);
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      // Numeric column sort (1-9). Broadcast for tables to consume.
      if (event.key >= "1" && event.key <= "9") {
        if (isSidebarShortcutDisabled()) return;
        event.preventDefault();
        const columnNumber = Number(event.key);
        window.dispatchEvent(
          new CustomEvent<SortColumnEventDetail>(SORT_COLUMN_EVENT, {
            detail: { columnNumber },
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

    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenCommandPalette);
    window.addEventListener("keydown", handleGlobalOverlayKeyDown);
    return () => {
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenCommandPalette);
      window.removeEventListener("keydown", handleGlobalOverlayKeyDown);
    };
  }, [openGlobalCommandPalette, toggleTheme]);

  return (
    <ToastContext.Provider value={{ addToast }}>
      <RouteProgressBar />
      {children}
      {commandPaletteLoaded && (
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      )}
      {keyboardShortcutsLoaded && (
        <KeyboardShortcuts open={keyboardShortcutsOpen} onOpenChange={setKeyboardShortcutsOpen} />
      )}
      {toasts.length > 0 && <ToastContainer toasts={toasts} removeToast={removeToast} />}
    </ToastContext.Provider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createPharosQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
        <AppProviders>{children}</AppProviders>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
