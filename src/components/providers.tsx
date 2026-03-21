"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, useTheme } from "next-themes";
import { useState, useCallback } from "react";
import { CommandPalette } from "./command-palette";
import { ToastContainer } from "./toast-container";
import { KeyboardShortcuts, useGlobalShortcuts } from "./keyboard-shortcuts";
import { useToast } from "@/hooks/use-toast";

// Create a context for toast functionality
import { createContext, useContext } from "react";

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
  const { theme, setTheme } = useTheme();
  const { toasts, addToast, removeToast } = useToast();

  const handleToggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
    addToast(`Switched to ${theme === "dark" ? "light" : "dark"} mode`, "info");
  }, [theme, setTheme, addToast]);

  const handleFocusSearch = useCallback(() => {
    // Dispatch event to open command palette
    window.dispatchEvent(new CustomEvent("open-command-palette"));
  }, []);

  const handleFocusTable = useCallback(() => {
    // Dispatch event to focus table
    window.dispatchEvent(new CustomEvent("focus-stablecoin-table"));
  }, []);

  const handleToggleFilters = useCallback(() => {
    // Dispatch event to toggle filters
    window.dispatchEvent(new CustomEvent("toggle-filters"));
    addToast("Filters toggled", "info");
  }, [addToast]);

  useGlobalShortcuts({
    onToggleTheme: handleToggleTheme,
    onFocusSearch: handleFocusSearch,
    onFocusTable: handleFocusTable,
    onToggleFilters: handleToggleFilters,
  });

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <CommandPalette />
      <KeyboardShortcuts />
      <ToastContainer toasts={toasts} removeToast={removeToast} />
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
