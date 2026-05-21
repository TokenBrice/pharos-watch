"use client";

import { useCallback, useState } from "react";
import { Moon, Sun, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { MotionPreferenceToggle } from "@/components/motion-preference-toggle";

// M17 — wrap the theme swap in a View Transition so the cross-dissolve
// happens as a single coordinated 220ms cross-fade across the viewport
// instead of an uncoordinated stutter of per-element transitions. Falls
// through to the bare toggle when the API is unavailable (Safari, FF).
function withViewTransition(run: () => void): void {
  if (typeof document === "undefined") {
    run();
    return;
  }
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  };
  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(run);
    return;
  }
  run();
}

export function ThemeToggle() {
  const { mounted, isDark, label, toggleTheme } = useThemeToggle();
  const [open, setOpen] = useState(false);

  const handleToggle = useCallback(() => {
    withViewTransition(toggleTheme);
  }, [toggleTheme]);
  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="h-9 w-9">
        <span className="sr-only">Display preferences</span>
      </Button>
    );
  }

  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9"
        onClick={handleToggle}
        aria-label={label}
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-7 -ml-0.5"
            aria-label="Display preferences"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-60 space-y-3 p-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground">
              Theme
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start gap-2 min-h-9 border border-border/70 bg-muted/20 hover:bg-muted/40"
              onClick={handleToggle}
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              <span className="text-xs font-medium">Switch to {isDark ? "light" : "dark"}</span>
            </Button>
          </div>
          <MotionPreferenceToggle />
        </PopoverContent>
      </Popover>
    </div>
  );
}
