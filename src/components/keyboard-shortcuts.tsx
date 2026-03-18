"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Shortcut {
  keys: string[];
  description: string;
  category: "Navigation" | "Actions" | "Table" | "Global";
}

const SHORTCUTS: Shortcut[] = [
  { keys: ["?"], description: "Show keyboard shortcuts", category: "Global" },
  { keys: ["Ctrl", "K"], description: "Open command palette", category: "Global" },
  { keys: ["[ / ]"], description: "Toggle sidebar pin", category: "Global" },
  { keys: ["/"], description: "Focus search", category: "Global" },
  { keys: ["Esc"], description: "Close modals/panels", category: "Global" },
  { keys: ["↑", "↓"], description: "Navigate items", category: "Navigation" },
  { keys: ["←", "→"], description: "Navigate tabs", category: "Navigation" },
  { keys: ["Enter"], description: "Select/open item", category: "Navigation" },
  { keys: ["T"], description: "Toggle theme", category: "Actions" },
  { keys: ["S"], description: "Focus stablecoin table", category: "Table" },
  { keys: ["F"], description: "Toggle filters", category: "Table" },
];

function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-0.5">
      {keys.map((key, i) => (
        <span key={i} className="flex items-center">
          <kbd className="rounded border border-border/70 bg-muted/50 px-1.5 py-0.5 text-xs font-mono">
            {key}
          </kbd>
          {i < keys.length - 1 && <span className="mx-0.5 text-muted-foreground">+</span>}
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Show shortcuts on '?' (but not when typing in inputs)
      if (
        e.key === "?" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setOpen(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const categories = [...new Set(SHORTCUTS.map((s) => s.category))];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {categories.map((category) => (
            <div key={category}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {category}
              </h3>
              <div className="space-y-1.5">
                {SHORTCUTS.filter((s) => s.category === category).map((shortcut, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/50"
                  >
                    <span className="text-sm text-foreground">{shortcut.description}</span>
                    <KeyCombo keys={shortcut.keys} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
          Press <kbd className="rounded border border-border/70 bg-muted/50 px-1 py-0.5 font-mono">Esc</kbd> to close
        </p>
      </DialogContent>
    </Dialog>
  );
}

// Hook to provide global keyboard shortcut functionality
export function useGlobalShortcuts({
  onToggleTheme,
  onFocusSearch,
  onFocusTable,
  onToggleFilters,
}: {
  onToggleTheme?: () => void;
  onFocusSearch?: () => void;
  onFocusTable?: () => void;
  onToggleFilters?: () => void;
}) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore if typing in input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case "t":
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            onToggleTheme?.();
          }
          break;
        case "/":
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            onFocusSearch?.();
          }
          break;
        case "s":
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            onFocusTable?.();
          }
          break;
        case "f":
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            onToggleFilters?.();
          }
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToggleTheme, onFocusSearch, onFocusTable, onToggleFilters]);
}
