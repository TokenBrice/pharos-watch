"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ThemeProvider } from "next-themes";
import { useState, useCallback, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/command-palette";
import { RouteProgressBar } from "@/components/route-progress-bar";

// Create a context for toast functionality
import { createContext, useContext } from "react";

// Vim-style g+x chord routing targets.
const CHORD_ROUTES: Record<string, string> = {
  h: "/",
  s: "/screener",
  c: "/compare",
  t: "/timeline",
  p: "/portfolio",
  d: "/digest",
  y: "/yield",
  l: "/liquidity",
  f: "/flows",
  v: "/freezewatch",
};

const CHORD_TIMEOUT_MS = 1500;

/**
 * Custom event broadcast when the user presses a numeric key (1-9) to sort
 * by the Nth visible column. Tables listen and call `toggleSort(visibleColumns[n-1])`.
 */
export const SORT_COLUMN_EVENT = "pharos-sort-column" as const;

export interface SortColumnEventDetail {
  columnNumber: number;
}

const CommandPalette = dynamic(() => import("./command-palette").then((mod) => mod.CommandPalette), {
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

export const ToastContext = createContext<ToastContextType | null>(null);

export function useToastContext() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToastContext must be used within ToastProvider");
  return ctx;
}

// Inner component that has access to theme
function AppProviders({ children }: { children: React.ReactNode }) {
  const { toasts, addToast, removeToast } = useToast();
  const { toggleTheme } = useThemeToggle({ toast: addToast });
  const router = useRouter();
  const [commandPaletteLoaded, setCommandPaletteLoaded] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [keyboardShortcutsLoaded, setKeyboardShortcutsLoaded] = useState(false);
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);

  const openGlobalCommandPalette = useCallback(() => {
    setCommandPaletteLoaded(true);
    setCommandPaletteOpen(true);
  }, []);

  const handleFocusSearch = openGlobalCommandPalette;

  const handleFocusTable = useCallback(() => {
    // Dispatch event to focus table
    window.dispatchEvent(new CustomEvent("focus-stablecoin-table"));
  }, []);

  // Chord state machine: when `g` is pressed, the next key (within 1.5s) is the chord target.
  const chordPendingRef = useRef(false);
  const chordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearChord = useCallback(() => {
    chordPendingRef.current = false;
    if (chordTimeoutRef.current !== null) {
      clearTimeout(chordTimeoutRef.current);
      chordTimeoutRef.current = null;
    }
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
        event.preventDefault();
        setKeyboardShortcutsLoaded(true);
        setKeyboardShortcutsOpen(true);
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      // Resolve chord if pending. The chord consumes the next single-key event,
      // taking precedence over any other single-key handler below.
      if (chordPendingRef.current) {
        const key = event.key.toLowerCase();
        const target = CHORD_ROUTES[key];
        clearChord();
        if (target) {
          event.preventDefault();
          router.push(target);
        }
        return;
      }

      // Start chord on `g`.
      if (event.key === "g") {
        event.preventDefault();
        chordPendingRef.current = true;
        if (chordTimeoutRef.current !== null) {
          clearTimeout(chordTimeoutRef.current);
        }
        chordTimeoutRef.current = setTimeout(() => {
          chordPendingRef.current = false;
          chordTimeoutRef.current = null;
        }, CHORD_TIMEOUT_MS);
        return;
      }

      // Numeric column sort (1-9). Broadcast for tables to consume.
      if (event.key >= "1" && event.key <= "9") {
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
          handleFocusSearch();
          break;
        case "s":
          event.preventDefault();
          handleFocusTable();
          break;
      }
    }

    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenCommandPalette);
    window.addEventListener("keydown", handleGlobalOverlayKeyDown);
    return () => {
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenCommandPalette);
      window.removeEventListener("keydown", handleGlobalOverlayKeyDown);
      if (chordTimeoutRef.current !== null) {
        clearTimeout(chordTimeoutRef.current);
        chordTimeoutRef.current = null;
      }
    };
  }, [clearChord, handleFocusSearch, handleFocusTable, openGlobalCommandPalette, router, toggleTheme]);

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
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            retry: 2,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <AppProviders>{children}</AppProviders>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
