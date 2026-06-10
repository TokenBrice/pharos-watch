"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isSidebarShortcutDisabled, setSidebarShortcutDisabled } from "@/lib/keyboard-shortcut-settings";

type KeyJoin = "+" | "then" | "or";

interface Shortcut {
  keys: string[];
  description: string;
  category: "Navigation" | "Actions" | "Tables" | "Global";
  join?: KeyJoin; // default "+"
}

const SHORTCUTS: Shortcut[] = [
  { keys: ["?"], description: "Show keyboard shortcuts", category: "Global" },
  { keys: ["Ctrl", "K"], description: "Open command palette", category: "Global" },
  { keys: ["[ / ]"], description: "Toggle sidebar pin", category: "Global" },
  { keys: ["/"], description: "Focus search", category: "Global" },
  { keys: ["Esc"], description: "Close modals/panels", category: "Global" },
  { keys: ["↑", "↓"], description: "Navigate items", category: "Navigation", join: "or" },
  { keys: ["←", "→"], description: "Navigate tabs", category: "Navigation", join: "or" },
  { keys: ["Enter"], description: "Select/open item", category: "Navigation" },
  { keys: ["T"], description: "Toggle theme", category: "Actions" },
  { keys: ["J", "↓"], description: "Next row", category: "Tables", join: "or" },
  { keys: ["K", "↑"], description: "Previous row", category: "Tables", join: "or" },
  { keys: ["O", "Enter"], description: "Open detail", category: "Tables", join: "or" },
  { keys: ["S"], description: "Toggle star (watchlist)", category: "Tables" },
  { keys: ["C"], description: "Add to compare", category: "Tables" },
  { keys: ["1", "9"], description: "Sort by column N (1-9)", category: "Tables", join: "or" },
];

function KeyCombo({ keys, join = "+" }: { keys: string[]; join?: KeyJoin }) {
  const separator = join === "+" ? "+" : join;
  return (
    <span className="flex items-center gap-0.5">
      {keys.map((key, i) => (
        <span key={i} className="flex items-center">
          <kbd className="rounded border border-border/70 bg-muted/50 px-1.5 py-0.5 text-xs font-mono tabular-nums">
            {key}
          </kbd>
          {i < keys.length - 1 && <span className="mx-0.5 text-muted-foreground">{separator}</span>}
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcuts({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const categories = [...new Set(SHORTCUTS.map((s) => s.category))];
  // This dialog is the only writer of the flag, so a lazy read stays accurate.
  const [sidebarShortcutEnabled, setSidebarShortcutEnabled] = useState(() => !isSidebarShortcutDisabled());

  const toggleSidebarShortcut = (enabled: boolean) => {
    setSidebarShortcutEnabled(enabled);
    setSidebarShortcutDisabled(!enabled);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                    <KeyCombo keys={shortcut.keys} join={shortcut.join} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <label className="flex items-center justify-between gap-3 border-t border-border/60 px-2 pt-3 text-sm">
          <span>
            Enable single-key shortcuts (
            <kbd className="rounded border border-border/70 bg-muted/50 px-1 py-0.5 font-mono tabular-nums">[ / ]</kbd>,{" "}
            <kbd className="rounded border border-border/70 bg-muted/50 px-1 py-0.5 font-mono tabular-nums">?</kbd>,{" "}
            <kbd className="rounded border border-border/70 bg-muted/50 px-1 py-0.5 font-mono tabular-nums">1-9</kbd>)
          </span>
          <input
            type="checkbox"
            checked={sidebarShortcutEnabled}
            onChange={(e) => toggleSidebarShortcut(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-primary"
          />
        </label>
        <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
          Press <kbd className="rounded border border-border/70 bg-muted/50 px-1 py-0.5 font-mono tabular-nums">Esc</kbd> to close
        </p>
      </DialogContent>
    </Dialog>
  );
}
