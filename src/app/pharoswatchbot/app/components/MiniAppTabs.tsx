"use client";

import { cn } from "@/lib/utils";
import type { ViewKey } from "../use-mini-app-view";

const ORDERED_VIEWS: ViewKey[] = ["home", "watchlist", "presets", "settings"];

function nextTabViewForKey(view: ViewKey, key: string): ViewKey | null {
  const index = ORDERED_VIEWS.indexOf(view);
  if (key === "ArrowRight") return ORDERED_VIEWS[(index + 1) % ORDERED_VIEWS.length];
  if (key === "ArrowLeft") return ORDERED_VIEWS[(index - 1 + ORDERED_VIEWS.length) % ORDERED_VIEWS.length];
  if (key === "Home") return ORDERED_VIEWS[0];
  if (key === "End") return ORDERED_VIEWS[ORDERED_VIEWS.length - 1];
  return null;
}

export function MiniAppTabs({ view, onActivate }: { view: ViewKey; onActivate: (view: ViewKey) => void }) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const nextView = nextTabViewForKey(view, event.key);
    if (!nextView) return;
    event.preventDefault();
    onActivate(nextView);
    document.getElementById(`pharos-mini-app-tab-${nextView}`)?.focus();
  };

  return (
    <nav className="grid grid-cols-4 gap-1 rounded-xl border border-border/65 bg-background/60 p-1" role="tablist" aria-label="Mini App sections">
      {ORDERED_VIEWS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          id={`pharos-mini-app-tab-${key}`}
          aria-controls={`pharos-mini-app-panel-${key}`}
          aria-selected={view === key}
          tabIndex={view === key ? 0 : -1}
          onClick={() => onActivate(key)}
          onKeyDown={handleKeyDown}
          className={cn(
            "pharos-focus-ring min-h-11 min-w-0 break-words rounded-lg px-1 text-xs font-semibold capitalize leading-tight transition-colors",
            view === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted/40",
          )}
        >
          {key}
        </button>
      ))}
    </nav>
  );
}
